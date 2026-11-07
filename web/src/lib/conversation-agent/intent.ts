/**
 * 本地意图识别：在调用模型之前确定「用户到底想做什么」。
 *
 * 背景：完整生图提示词（只描述画面）与「生成图片：…」这类请求，如果完全交给模型判断，
 * 容易被当成聊天点评提示词。这里用确定性规则给出高置信度路由：
 * - direct=true 的生成/改图意图由运行时直接执行工具，不必等模型决定；
 * - 其余生成/改图意图注入意图指令，并在模型不调用工具时兜底执行。
 */

export type AgentIntentKind = "chat" | "generate_image" | "edit_image" | "apply_prompt";

export type AgentIntent = {
    kind: AgentIntentKind;
    /** 已提取出的提示词正文；chat / apply_prompt 为空串。 */
    prompt: string;
    /** 用户是否明确说出了动作（如「生成图片」），而不是只粘贴了一段提示词。 */
    explicit: boolean;
    /** 是否可以直接执行工具，无需模型参与。 */
    direct: boolean;
    /** 输出格式要求：gif 或 png */
    format?: "png" | "gif";
    /** 背景模式：transparent 时下发透明底生成指令 */
    background?: "transparent" | "auto";
};

export const CHAT_INTENT: AgentIntent = { kind: "chat", prompt: "", explicit: false, direct: false };

/** 动图/GIF 意图关键词：命中时将 format 置为 gif 并调用支持动图的模型。 */
export const GIF_INTENT_PATTERN = /动图|动态图|动态表情包|动效表情包|\bgif\b|会动的|animated\s+image|animated\s+gif|\banimation\b/i;

/** 透明背景意图关键词：命中时将 background 置为 transparent，向模型与生图接口下发透明底指令。 */
export const TRANSPARENT_INTENT_PATTERN = /透明底|透明背景|透明图|透明png|png透明|transparent\s*(background|png)?/i;

/** 画面要素类别：命中越多，越可能是一段完整的生图提示词。 */
const VISUAL_CATEGORY_PATTERNS: RegExp[] = [
    // 风格/摄影
    /摄影|写实|真实|胶片|电影感|质感|风格|style|photo|realistic|cinematic|film/i,
    // 镜头/构图
    /镜头|景深|构图|特写|广角|微距|50mm|85mm|35mm|lens|depth of field|bokeh|composition|close[- ]?up/i,
    // 光线/氛围
    /光线|自然光|柔光|逆光|氛围|灯光|照明|光斑|light|lighting|backlight|golden hour/i,
    // 色彩
    /色彩|色调|配色|color|palette|tone/i,
    // 人物主体
    /少女|女孩|女性|男生|男孩|人物|肖像|角色|woman|girl|man|boy|portrait|character/i,
    // 服装
    /水手服|校服|JK|连衣裙|百褶裙|服装|穿搭|outfit|uniform|dress/i,
    // 场景/背景
    /背景|场景|校园|樱花|街道|城市|森林|天空|海边|室内|房间|scene|background|street|forest|sky/i,
    // 表情姿态
    /回眸|微笑|姿态|动作|看向|镜头前|pose|smile|looking/i,
    // 画质细节
    /细节|纹理|皮肤|画质|高清|超清|8k|4k|detail|texture|high quality|sharp/i,
    // 负面约束
    /避免|不要|负面|avoid/i,
];

/** 提示词编写/优化/评价/检查类元指令：这些仍然走聊天。 */
const PROMPT_META_PATTERNS: RegExp[] = [
    /(写|编写|创作|拟|起草|生成|做|出)[^。！？!?\n]{0,10}提示词/,
    /(优化|润色|改写|重写|评价|点评|检查|分析|解释|翻译|改进)[^。！？!?\n]{0,12}(提示词|这段|这句|prompt)/i,
    /(提示词|prompt)[^。！？!?\n]{0,8}(优化|润色|改写|重写|评价|点评|建议|怎么样|如何|改|检查|refine|improve|rewrite|polish|review)/i,
    /(refine|improve|rewrite|polish|review|translate|explain)[^\n]{0,20}(prompt|text)/i,
];

/** 明确否定生成动作：仍然走聊天。 */
const NEGATION_PATTERNS: RegExp[] = [
    /(不要|别|不用|不必|先不|无需)[^。！？!?\n]{0,6}(生成|出图|画)/,
    /(只|仅)[^。！？!?\n]{0,6}(写|要|给|输出)[^。！？!?\n]{0,6}提示词/,
];

const APPLY_PROMPT_PATTERN = /(填入|填到|填进|放到|放进|导入到?)[^。！？!?\n]{0,10}(工作台|生图工作台|视频创作台)/;

/** 改图动作词：有参考图时才判定为编辑。 */
const EDIT_ACTION_PATTERN =
    /修改|改成|改一?下|换成|替换|去掉|删除|加上|添加|变成|调成|调亮|调暗|换背景|换风格|换个|重绘|修复|裁剪|放大|缩小|不要把|(?:把|将)[^。！？!?\n]{0,20}(?:改|换|调|加|去|删|移|变|修)/i;
const ENGLISH_EDIT_ACTION_PATTERN = /\b(edit|change|replace|remove|add)\b/i;

/** 显式生成动作：用户明确要求出图（「生图工作台」是功能名，不算生成动作）。 */
const GENERATE_ACTION_PATTERN =
    /(?:生成|做|画|来|制作)\s*(?:一?\s*[个张幅份版])?[^。！？!?\n]{0,15}?(?:动图|动态表情包|动态图|\bgif\b|表情包|透明图|透明底|透明图片|透明png|png透明|透明素材)|生成图片|生成一张|生成一幅|生成几张|生成\s*\d+\s*[张幅个]|生成\s*[一二两三几]\s*[张幅个]|出图|出\s*\d+\s*[张幅个]|画一张|画个|画幅|画张|帮我画|来一张|再来一版|再生成|重新生成|换一版|做一张|做个|生成海报|生成插画|生成照片|生成头像|生成壁纸|生成封面|生图(?!\s*工作台)|generate\s+(an?\s+|the\s+)?(?:animated\s+|transparent\s+)?(image|picture|photo|illustration|poster|gif|png)|draw\s+(me\s+)?|create\s+(an?\s+)?(?:animated\s+|transparent\s+)?(image|picture|gif|png)|make\s+(an?\s+)?(?:animated\s+|transparent\s+)?(image|picture|gif|png)/i;

/** 帮助/用法类提问：即使带「生图 / 生成图片」字样也不是出图请求，必须走聊天。 */
const HELP_QUESTION_PATTERN =
    /^(?:怎么|如何|怎样|为什么|哪里|在哪|什么|是否|能不能|可不可以|请问)|在哪|哪里|怎么用|如何使用|怎么操作|有什么区别/i;

/** 冒号形式必须「生成指令词紧邻冒号」，避免把 16:9 这类比例冒号当成分隔符。 */
const COLON_GENERATE_PATTERN =
    /^(?:请|帮我|麻烦|给我)?\s*(?:生成|画|出|做|来|绘制)(?:一?[张幅个组])?(?:图片|图像|图|照片|插画|海报|头像|壁纸|封面|作品|动图|动态图|动态表情包|表情包|gif|透明图|透明底|透明图片|透明png|png透明|png透明图片|png透明图)?\s*[：:]\s*([\s\S]+)$/i;

/** 开头的客套/连接词，提取正文时先去掉。 */
const LEADING_FILLER_PATTERN = /^(?:请|麻烦|帮我|帮忙|给我|再|重新|继续|然后|现在|直接)+[\s，,。.!！、]*/;

/** 生成类指令词 + 量词/对象词，提取正文时去掉（量词兼容「一张 / 2 张 / 两张」）。 */
const LEADING_GENERATE_PATTERN =
    /^(?:生成|创建|绘制|画|出图|出|做|来|制作|换)\s*(?:一?\s*[张幅个组份版]|几\s*[张幅个]|\d+\s*[张幅个]|[一二两三几]\s*[张幅个])?\s*(?:图片|图像|照片|插画|海报|头像|壁纸|封面|图|画|作品|动图|动态图|动态表情包|表情包|gif|透明图|透明底|透明图片|透明png|png透明|png透明图片|png透明图)?\s*[：:，,。.!！、\s]*/i;

/** 指代型文本：这类内容不能当作提示词，交给运行时用历史 promptBlocks 兜底。 */
const REFERENCE_PROMPT_PATTERN = /(提示词|这张图|那张图|这个|那个|上面|上述|刚才|之前|参考图)/i;

/** 英文生成指令前缀。 */
const LEADING_EN_PATTERN =
    /^(?:please\s+)?(?:generate|draw|create|make)\s+(?:me\s+)?(?:an?\s+)?(?:animated\s+)?(?:image|picture|photo|illustration|poster|gif)\s*(?:of|with|showing|about)?\s*[:：,，。.]*\s*/i;

/** 闲聊/提问开头，不能当作完整提示词。 */
const SMALL_TALK_PATTERN = /^(什么|为什么|怎么|如何|能不能|可以|是不是|有没有|你好|您好|谢谢|嗯|在吗|嗨|hello|hi|thanks)/i;

function countVisualCategories(text: string) {
    let count = 0;
    for (const pattern of VISUAL_CATEGORY_PATTERNS) if (pattern.test(text)) count += 1;
    return count;
}

function hasMetaInstruction(text: string) {
    return PROMPT_META_PATTERNS.some((pattern) => pattern.test(text));
}

/** 提取冒号形式（生成图片：…）的正文；只有指令词紧邻冒号时才成立。 */
function extractColonBody(text: string) {
    const match = text.match(COLON_GENERATE_PATTERN);
    return match ? match[1].trim() || null : null;
}

/** 指代型文本：仅当其中没有任何画面要素时才清空，避免把冒号后显式给出的完整提示词误删。 */
function sanitizeExtractedPrompt(prompt: string, input: string) {
    if (!prompt) return "";
    if (REFERENCE_PROMPT_PATTERN.test(prompt) && countVisualCategories(prompt) === 0) return "";
    if (prompt === input && countVisualCategories(prompt) === 0) return "";
    return prompt;
}

/** 去掉「帮我生成一张…」这类指令前缀，得到提示词正文。 */
function stripInstructionPrefix(text: string) {
    const trimmed = text.trim().replace(LEADING_FILLER_PATTERN, "").trim();
    const stripped = trimmed.replace(LEADING_GENERATE_PATTERN, "").replace(LEADING_EN_PATTERN, "").trim();
    return stripped.replace(/^[，,。.!！、：:\s]+/, "").trim();
}

function isQuestion(text: string) {
    return /[？?]\s*$/.test(text) || /[吗呢]\s*$/.test(text);
}

/**
 * 判定用户本轮意图。判定顺序严格固定：元指令 → 否定 → 填入工作台 → 改图 → 显式生成 → 提示词相关 → 独立完整提示词 → 聊天。
 */
export function detectAgentIntent(text: string, options?: { hasReferences?: boolean }): AgentIntent {
    const input = text.trim();
    if (!input) return CHAT_INTENT;
    // ① 提示词编写/优化/评价/检查类元指令 → 聊天
    if (hasMetaInstruction(input)) return CHAT_INTENT;
    // ② 明确否定生成 / 只要提示词 → 聊天
    if (NEGATION_PATTERNS.some((pattern) => pattern.test(input))) return CHAT_INTENT;
    // ③ 填入/放到工作台 → apply_prompt（具体参数交给模型补全）
    if (APPLY_PROMPT_PATTERN.test(input)) return { kind: "apply_prompt", prompt: "", explicit: true, direct: false };
    // ④ 有参考图且包含改图动作 → 直接改图；没有参考图则继续往下判断
    if (options?.hasReferences === true && (EDIT_ACTION_PATTERN.test(input) || ENGLISH_EDIT_ACTION_PATTERN.test(input))) {
        return { kind: "edit_image", prompt: input, explicit: true, direct: true };
    }
    const isGif = GIF_INTENT_PATTERN.test(input);
    const isTransparent = TRANSPARENT_INTENT_PATTERN.test(input);
    const colonBody = extractColonBody(input);
    // ⑤ 帮助/用法类提问 → 聊天（冒号形式视为用户已显式给出正文，不做提问短路）
    if (!colonBody && (isQuestion(input) || HELP_QUESTION_PATTERN.test(input))) return CHAT_INTENT;
    // ⑥ 显式生成动作 → 生成图片
    if (GENERATE_ACTION_PATTERN.test(input)) {
        const stripped = stripInstructionPrefix(input);
        let prompt = colonBody ?? stripped;
        if (!prompt && countVisualCategories(input) >= 2 && input.length >= 24) prompt = input;
        prompt = sanitizeExtractedPrompt(prompt, input);
        const direct = Boolean(colonBody && prompt) || prompt.length >= 24 || countVisualCategories(prompt) >= 2;
        return {
            kind: "generate_image",
            prompt,
            explicit: true,
            direct,
            ...(isGif ? { format: "gif" as const } : {}),
            ...(isTransparent ? { background: "transparent" as const } : {}),
        };
    }
    // ⑦ 提到提示词但没有明确动作 → 聊天（例如「用这个提示词生成图片」已在⑥命中）
    if (/提示词|prompt/i.test(input)) return CHAT_INTENT;
    // ⑧ 独立完整生图提示词：不是提问/闲聊，长度和画面要素都达标 → 直接出图
    if (
        !isQuestion(input) &&
        !SMALL_TALK_PATTERN.test(input) &&
        input.replace(/\s+/g, "").length >= 30 &&
        countVisualCategories(input) >= 2
    ) {
        return {
            kind: "generate_image",
            prompt: input,
            explicit: false,
            direct: true,
            ...(isGif ? { format: "gif" as const } : {}),
            ...(isTransparent ? { background: "transparent" as const } : {}),
        };
    }
    // ⑨ 其余 → 聊天
    return CHAT_INTENT;
}
