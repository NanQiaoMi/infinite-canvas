/**
 * 本地意图识别：在调用模型之前确定「用户到底想做什么」。
 *
 * 核心升级：
 * 1. 深度理解用户的真实用途（小红书、电商主图、游戏原画、海报分层、头像、表情包、Logo 等）；
 * 2. 识别任务拆解与批量生成需求（拆分素材、成套图层、多视角立绘）；
 * 3. 区分纯咨询与礼貌生图请求（避免「能不能帮我画个猫咪？」被误当成聊天）；
 * 4. 为模型与运行时提供结构化的意图元数据与指令路由。
 */

import { inferImageSizeFromPrompt } from "./aspect-ratio";
import type { AgentToolCall } from "./types";

export type AgentIntentKind = "chat" | "generate_image" | "edit_image" | "apply_prompt";

export type AgentIntent = {
    kind: AgentIntentKind;
    /** 已提取出的提示词正文；chat / apply_prompt 为空串。 */
    prompt: string;
    /** 用户是否明确说出了动作（如「生成图片」「帮我做一张」），而不是只粘贴了一段提示词。 */
    explicit: boolean;
    /** 是否可以直接执行工具，无需模型参与（仅显式命令或带参考图的明确改图会直连）。 */
    direct: boolean;
    /** 是否为显式命令（如「生成图片：…」冒号形式）；显式命令绕过模型直连执行。 */
    explicitCommand?: boolean;
    /** 输出格式要求：gif 或 png */
    format?: "png" | "gif";
    /** 画幅尺寸要求（如 1536x864、1024x1024 等） */
    size?: string;
    /** 背景模式：transparent 时下发透明底生成指令 */
    background?: "transparent" | "auto";
    /** 是否属于任务拆解、多图层素材或成套生成任务 */
    decompose?: boolean;
    /** 识别出的具体业务场景或用途定位（如海报、小红书、电商、表情包等） */
    usageScene?: string;
    /** 期望生成的批量张数 */
    batchCount?: number;
    /** 是否涉及画布节点创建与排布操作 */
    isCanvas?: boolean;
    /** 排布布局模式：horizontal (横向并排) / vertical (纵向并排) / grid (网格) */
    layout?: "horizontal" | "vertical" | "grid";
};

export const CHAT_INTENT: AgentIntent = { kind: "chat", prompt: "", explicit: false, direct: false };

/** 动图/GIF 意图关键词：命中时将 format 置为 gif 并调用支持动图的模型。 */
export const GIF_INTENT_PATTERN = /动图|动态图|动态表情包|动效表情包|\bgif\b|会动的|animated\s+image|animated\s+gif|\banimation\b/i;

/** 透明背景意图关键词：命中时将 background 置为 transparent，向模型与生图接口下发透明底指令。 */
export const TRANSPARENT_INTENT_PATTERN = /透明底|透明背景|透明图|透明png|png透明|transparent\s*(background|png)?/i;

/** 任务拆解与批量生成意图关键词：命中时标记 decompose 为 true */
export const DECOMPOSE_INTENT_PATTERN =
    /拆解|拆分|分解|分层|多图层|图层素材|成套|一套|组图|系列|多角度|不同风格|四格|九宫格|分步生成|批量生成|多素材|海报素材|设计素材|游戏素材|各类素材|系列素材|素材套件|套件|并排排开|在画布排开|分步/i;

/** 画布节点生成与排布意图关键词：命中时标记 isCanvas 为 true */
export const CANVAS_ACTION_PATTERN = /画布|节点|并排|排开|横排|横向排列|竖排|纵排|网格排列|并在画布/i;

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
    // 人物主体/公众人物/职业角色
    /少女|女孩|女性|男生|男孩|人物|肖像|角色|神仙|神话|西游记|古典|孙悟空|猪八戒|唐僧|沙僧|沙和尚|哪吒|二郎神|白骨精|牛魔王|法术|仙侠|武侠|机甲|精灵|妖怪|奥特曼|特朗普|马斯克|拜登|普京|名人|明星|偶像|大叔|老人|青年|模特|员工|店员|服务员|厨师|医生|护士|教师|学生|工人|程序员|CEO|总裁|职员|柜员|顾客|人类|男士|女士|学者|专家|艺术家|演员|歌手|运动员|观众|市民|路人|群演|群像|双人|三人|多人|两口子|母女|父子|朋友|情侣|伙伴|合影|集体照|全家福|woman|girl|man|boy|portrait|character|person|people/i,
    // 动物与宠物
    /猫|狗|小猫|大猫|胖猫|橘猫|柯基|柴犬|宠物|萌宠|动物|小动物|鸟|龙|小熊|兔子|cat|dog|kitten|puppy|animal|pet/i,
    // 静物与道具
    /物体|静物|食物|水果|苹果|饮品|花卉|植物|机甲|武器|道具|药水|瓶子|图标|徽标|汽车|飞机|飞船|爆米花|可乐|object|food|flower|weapon|potion/i,
    // 服装
    /水手服|校服|JK|连衣裙|百褶裙|服装|穿搭|毛衣|西装|工作服|制服|衬衫|围裙|outfit|uniform|dress|suit/i,
    // 场景/背景/空间场所
    /背景|场景|校园|樱花|街道|城市|森林|天空|海边|室内|房间|车厢|地铁|公交|列车|火车|高铁|站台|车站|马路|公路|商场|广场|建筑|桥梁|走廊|客车|电影院|影院|影厅|柜台|吧台|前台|服务台|收银台|收银|超市|便利店|商店|店铺|餐厅|食堂|咖啡厅|咖啡馆|酒吧|茶馆|夜市|集市|办公室|工位|会议室|工厂|车间|仓库|厨房|书房|客厅|卧室|卫生间|阳台|花园|球场|体育场|舞台|展厅|展览馆|博物馆|图书馆|医院|病房|诊所|药店|实验室|教室|学校|码头|港口|机场|候机楼|航站楼|停机坪|街景|街角|户外|广场|公园|操场|草坪|海滩|屋顶|天台|过道|走道|scene|background|street|forest|sky|cinema|theater|counter|office|store|shop/i,
    // 表情姿态/动作/活动
    /回眸|微笑|姿态|动作|看向|镜头前|拥挤|站立|坐着|通勤|工作|上班|值班|忙碌|繁忙|服务|售货|售卖|营业|操作|交谈|聊天|讨论|开会|走路|跑步|行走|站|坐|躺|跳|演奏|弹奏|制作|烹饪|收银|用餐|喝|看|写|画|互动|交流|对视|排队|购物|浏览|挑选|欢笑|低头|抬头|侧身|背影|正面|pose|smile|looking|working|standing|sitting/i,
    // 空间方位结构（在...里/后面/前面/旁边/中间）
    /在.+?(?:里|中|内|上|下|前|后|后面|前面|旁边|周围|中央|之中|身旁|身后|眼前)|位于|处于|穿梭于|环绕|环顾|面对/i,
    // 画质细节与视觉文字
    /细节|纹理|皮肤|画质|高清|超清|8k|4k|滚动屏|电子屏|显示屏|标示|标识|警告|标志|海报|贴纸|文字|字体|牌匾|灯牌|霓虹灯|标语|反光|透光|投影|玻璃|detail|texture|high quality|sharp/i,
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
    /(不要|别|不用|不必|先不|无需)[^。！？!?\n]{0,6}(生成|出图|画|做图|设计)/,
    /(只|仅)[^。！？!?\n]{0,6}(写|要|给|输出)[^。！？!?\n]{0,6}提示词/,
];

const APPLY_PROMPT_PATTERN = /(填入|填到|填进|放到|放进|导入到?)[^。！？!?\n]{0,10}(工作台|生图工作台|视频创作台)/;

/** 改图动作词：有参考图时才判定为编辑。 */
const EDIT_ACTION_PATTERN =
    /修改|改成|改一?下|换成|替换|去掉|删除|加上|添加|变成|调成|调亮|调暗|换背景|换风格|换个|重绘|修复|裁剪|放大|缩小|不要把|(?:把|将)[^。！？!?\n]{0,20}(?:改|换|调|加|去|删|移|变|修)/i;
const ENGLISH_EDIT_ACTION_PATTERN = /\b(edit|change|replace|remove|add)\b/i;

/** 纯使用咨询/功能提问模式：这些才是真正的咨询聊天。 */
const PURE_INQUIRY_PATTERN =
    /^(?:如何|怎么|怎样|为什么|啥是|什么是|请问(?:怎么|如何|怎样))|(?:怎么用|如何使用|怎么操作|有什么区别|支持哪些模型|为什么会有|怎么配置|哪里设置|怎么导入|如何连接|怎么收费|多少额度|怎么导出|快捷键有哪些|怎么开通|怎么购买|要多久|多长时间|多久|保存下来|打开(?:生图)?工作台|在哪|哪里)/i;

/** 常见用途场景识别规则 */
const USAGE_SCENE_RULES: Array<{ scene: string; pattern: RegExp }> = [
    { scene: "小红书/美妆穿搭推广", pattern: /小红书|种草|美妆|护肤品|穿搭|ootd|通透水光肌/i },
    { scene: "电商产品/广告主图", pattern: /电商|淘宝|京东|亚马逊|商品图|产品主图|产品白底|瓶身特写|商业广告/i },
    { scene: "海报设计/视觉封面", pattern: /海报|宣传海报|活动海报|电影海报|封面|杂志封面|书籍封面|banner|横幅/i },
    { scene: "游戏原画/角色立绘", pattern: /游戏原画|原画|角色立绘|立绘|机甲|二次元|三视图|概念设定|游戏ui/i },
    { scene: "微信表情包", pattern: /(?:微信)?表情包|动态表情包|微信表情/i },
    { scene: "Logo/图标设计", pattern: /logo|标志|徽标|图标|icon|ui图标|矢量图标/i },
    { scene: "手机壁纸/电脑桌面", pattern: /手机壁纸|壁纸|锁屏|电脑桌面|横屏壁纸|4k壁纸/i },
    { scene: "社交头像", pattern: /头像|微信头像|情侣头像|卡通头像|动漫头像/i },
];

/** 显式生成动作：支持丰富的创作、设计、拆解及用途表达 */
const GENERATE_ACTION_PATTERN =
    /(?:(?:能不能|可不可以|可以|请|帮我|麻烦|给我|想|想要|打算|需要)\s*)?(?:生成|制作|创作|设计|画|做|出|来|搞|整|安排|弄)\s*(?:一?\s*[个张幅份套组版]|几\s*[张幅个套组]|\d+\s*[张幅个套组]|[一二两三四五六七八九几]\s*[张幅个套组])?[^。！？!?\n]{0,20}?(?:动图|动态表情包|动态图|\bgif\b|表情包|透明图|透明底|透明图片|透明png|png透明|透明素材|海报|插画|插图|照片|头像|壁纸|封面|图标|logo|标志|素材|立绘|原画|电商图|小红书图|图片|图|画|作品)|(?:再?来|出)\s*(?:\d+|[一二两三四五六七八九几])\s*[张幅个套组版]|生成图片|生成一张|生成一幅|生成几张|生成\s*\d+\s*[张幅个]|生成\s*[一二两三四五六七八九几]\s*[张幅个]|出图|出\s*\d+\s*[张幅个]|画一张|画个|画幅|画张|帮我画|来一张|再来一版|再生成|重新生成|换一版|做一张|做个|设计一张|设计一个|生图(?!\s*工作台)|(?:拆解|拆分)[^。！？!?\n]{0,15}?(?:生成|素材|图层)|generate\s+(an?\s+|the\s+)?(?:animated\s+|transparent\s+)?(image|picture|photo|illustration|poster|gif|png)|draw\s+(me\s+)?|design\s+(an?\s+)?|create\s+(an?\s+)?(?:animated\s+|transparent\s+)?(image|picture|gif|png)|make\s+(an?\s+)?(?:animated\s+|transparent\s+)?(image|picture|gif|png)/i;

/** 冒号形式必须「生成指令词紧邻冒号」，避免把 16:9 这类比例冒号当成分隔符。 */
const COLON_GENERATE_PATTERN =
    /^(?:请|帮我|麻烦|给我)?\s*(?:生成|画|出|做|来|绘制|设计|制作)(?:一?[张幅个组套])?(?:图片|图像|图|照片|插画|海报|头像|壁纸|封面|作品|动图|动态图|动态表情包|表情包|gif|透明图|透明底|透明图片|透明png|png透明|png透明图片|png透明图)?\s*[：:]\s*([\s\S]+)$/i;

/** 开头的客套/连接词，提取正文时先去掉。 */
const LEADING_FILLER_PATTERN =
    /^(?:请|麻烦|帮我|帮忙|给我|再|重新|继续|然后|现在|直接|我想|想要|打算|能不能帮我|可以帮我|能帮我|在画布上?|在画板上?|在无限画布上?)+[\s，,。.!！、]*/;

/** 生成类指令词 + 量词/对象词，提取正文时去掉。 */
const LEADING_GENERATE_PATTERN =
    /^(?:(?:在画布上?|在画板上?|在无限画布上?)\s*)?(?:批量)?(?:生成|创建|绘制|画|出图|出|做|来|制作|换|设计|搞|整|安排|弄)\s*(?:一套\s*(?:\d+|[一二两三四五六七八九])\s*[个张幅次]|一套|一组|一?\s*[张幅个组份版套次]|几\s*[张幅个套次]|\d+\s*[张幅个套次]|[一二两三四五六七八九几]\s*[张幅个套次])?\s*(?:(?:透明底|透明背景|透明图|透明png|png透明|png透明图片|png透明图)?\s*(?:图片|图像|照片|插画|海报|头像|壁纸|封面|图|画|作品|动图|动态图|动态表情包|表情包|gif|素材|图标))?\s*[：:，,。.!！、\s]*/i;

/** 指代型文本：这类内容不能当作提示词，交给运行时用历史 promptBlocks 兜底。 */
export const REFERENCE_PROMPT_PATTERN = /(提示词|这张图|那张图|这个|那个|上面|上述|刚才|之前|参考图)/i;

/** 英文生成指令前缀。 */
const LEADING_EN_PATTERN =
    /^(?:please\s+)?(?:generate|draw|create|make|design)\s+(?:me\s+)?(?:an?\s+)?(?:animated\s+)?(?:image|picture|photo|illustration|poster|gif)\s*(?:of|with|showing|about)?\s*[:：,，。.]*\s*/i;

/** 纯闲聊开头。 */
const SMALL_TALK_PATTERN = /^(你好|您好|谢谢|嗯|在吗|嗨|hello|hi|thanks)/i;

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

/** 提取期望批量生成的张数（如「4张」「一套3个」「一套十个」「共10张」「十二个生肖」） */
function extractBatchCount(text: string): number | undefined {
    const cnMap: Record<string, number> = {
        一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
        十: 10, 十一: 11, 十二: 12,
    };
    // 优先匹配如「一套3个」「一组10张」「一套十个」中“套/组”后面的具体数量
    const suiteMatch = text.match(/(?:一套|一组)\s*(?:共|一共|总共)?\s*(\d+|十一|十二|十|[一二两三四五六七八九])\s*[张幅个次]/);
    if (suiteMatch) {
        const val = suiteMatch[1];
        if (/^\d+$/.test(val)) return Math.min(12, Math.max(1, parseInt(val, 10)));
        if (cnMap[val]) return cnMap[val];
    }
    const numMatch = text.match(/(?:共|一共|总共)?\s*(\d+)\s*[张幅个套组次]/);
    if (numMatch) return Math.min(12, Math.max(1, parseInt(numMatch[1], 10)));
    const cnMatch = text.match(/(?:共|一共|总共)?\s*(十一|十二|十|[一二两三四五六七八九])\s*[张幅个套组次]/);
    if (cnMatch && cnMap[cnMatch[1]]) return cnMap[cnMatch[1]];
    return undefined;
}

function stripNegativePrompt(text: string): string {
    return text
        .replace(/(?:\[负面提示词\]|负面提示词|negative prompt|negative:|避免|avoid)[\s\S]*$/i, "")
        .trim();
}

/** 识别具体的业务场景用途（先隔离负面提示词，避免负面词中的「LOGO」「文字」等反向触发场景误判） */
function detectUsageScene(text: string): string | undefined {
    const positiveText = stripNegativePrompt(text) || text;
    for (const rule of USAGE_SCENE_RULES) {
        if (rule.pattern.test(positiveText)) return rule.scene;
    }
    return undefined;
}

/** 指代型文本：仅当纯为指令词且没有任何具体主体时才清空，避免误删包含画面的提示词。 */
function sanitizeExtractedPrompt(prompt: string, input: string) {
    if (!prompt) return "";
    if (REFERENCE_PROMPT_PATTERN.test(prompt) && countVisualCategories(prompt) === 0) return "";
    if (prompt === input && countVisualCategories(prompt) === 0 && prompt.length < 16) return "";
    return prompt;
}

/** 去掉「帮我生成一张…」「在画布上生成一套3个…」这类指令前缀，得到干净提示词正文。 */
export function stripInstructionPrefix(text: string) {
    let trimmed = text.trim().replace(LEADING_FILLER_PATTERN, "").trim();
    trimmed = trimmed.replace(LEADING_GENERATE_PATTERN, "").replace(LEADING_EN_PATTERN, "").trim();
    trimmed = trimmed.replace(/^(?:透明底|透明背景|透明图|透明png|png透明|png透明图片|png透明图)+[\s，,。.!！、]*/i, "").trim();
    trimmed = trimmed.replace(/^(?:再|重新)?(?:生成|来|做|出|搞)?\s*一?次[，,。.!！、\s]*/i, "").trim();
    trimmed = trimmed.replace(/^(?:共|一共|总共)?\s*(?:\d+|十一|十二|十|[一二两三四五六七八九几])\s*[张幅个套组次][，,。.!！、\s]*/i, "").trim();
    trimmed = trimmed.replace(/[，,。.!！、\s]*(?:共|一共|总共)?\s*(?:\d+|十一|十二|十|[一二两三四五六七八九几])\s*[张幅个套组次]$/i, "").trim();
    trimmed = trimmed.replace(/[，,。.!！、\s]*(?:再|重新)?(?:生成|来|做|出|搞)?\s*一?次$/i, "").trim();
    const stripped = trimmed.replace(/^[，,。.!！、：:\s]+/, "").trim();
    const cleanTrailing = stripped.replace(/(?:[，,。.!！、：:\s]+|(?:请|帮我)?(?:生成|出图|做图|制作|绘制))+$/i, "").trim();
    if ((cleanTrailing === "素材" || !cleanTrailing) && /海报/i.test(text)) {
        return "海报设计素材（主体核心元素、装饰边框与纹样）";
    }
    if ((cleanTrailing === "素材" || !cleanTrailing) && /游戏/i.test(text)) {
        return "游戏道具素材";
    }
    return cleanTrailing;
}

/** 提取续作/增补中的微调要求（如从「换个姿势再来一个」中提取「换个姿势」，从「要双爪合十求抱抱」中提取「双爪合十求抱抱」） */
export function extractFollowUpModification(input: string): string {
    let text = input.trim();
    text = text.replace(/^(?:我?想要?|来个|整个|搞个|做个|换成|选|我选)\s*/i, "");
    text = text.replace(/^(?:再|另外再?|重新|接着|继续)?(?:生成|画|来|做|出|整|搞)?\s*(?:一?[个张幅组套版次]|几[个张幅次]|同款)?[，,。.!！、\s]*/i, "");
    text = text.replace(/(?:[，,。.!！、\s]*(?:共|一共|总共)?\s*(?:\d+|十一|十二|十|[一二两三四五六七八九几])\s*[张幅个套组次])+/gi, "");
    text = text.replace(/(?:[，,。.!！、\s]*(?:再|重新|另外再?|接着|继续)?(?:生成|画|来|做|出|整|搞)?\s*(?:一?[个张幅组套版次]|几[个张幅次]|同款)?)+$/gi, "");
    text = text.replace(/^[，,。.!！、：:\s]+|[，,。.!！、：:\s]+$/g, "");
    if (/^(?:再|重新|继续|再来|再出|再做|再生成)?(?:一?次|一?张|一?版|横屏|竖屏|方屏|横版|竖版|方版|横图|竖图|方图)?(?:的|图)?$/i.test(text)) return "";
    return text;
}

/** 延续上一轮生成的追问/增补指令：如「再生成一个」「再来一张」「换个姿势再来一个」「不改变她原来的脸，再来一张」「要双爪合十求抱抱」 */
export const FOLLOW_UP_PATTERN =
    /^(?:我?想要?|来个|整个|搞个|做个|换成|选|我选)\s*([^。！？!?\n]{2,30})|(?:再|另外再?|重新|接着|继续|换[个一次]|换种|换套|换身|按[照这个]?风格再?|延续[这个]?风格再?)(?:生成|画|来|做|出|整|搞)?\s*(?:一?[个张幅组套版次]|几[个张幅次]|\d+\s*[个张幅组套版次]|[一二两三四五六七八九几]\s*[个张幅组套版次]|同款)?|^(?:再?来|再?搞|再?整|再?出|再?做)\s*(?:\d+|[一二两三四五六七八九几])\s*[个张幅组套版次]|不改变.*再来|换个.*再[来画生成]|延续.*再[来画生成]|按.*风格.*再|再生成一次|再来一次/i;

/** 提取上一轮助手回复中推荐的选项（如「摸摸」或者「双爪合十求抱抱」） */
export function extractAssistantSuggestions(history?: Array<{ role: string; text?: string }>): string[] {
    if (!history || !history.length) return [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const item = history[index];
        if (item.role === "assistant" && item.text) {
            const matches: string[] = [];
            const quoteRegex = /[「『"“]([^」』"”\n]{2,25})[」』"”]/g;
            let m;
            while ((m = quoteRegex.exec(item.text)) !== null) {
                matches.push(m[1].trim());
            }
            if (matches.length > 0) return matches;
        }
    }
    return [];
}

/** 追溯历史会话中最近一次的生成提示词，用于「再生成一个」「换个姿势再来一张」等延续生成意图 */
export function findLastGenerationPrompt(history?: Array<{ role: string; text?: string; content?: string; call?: AgentToolCall | { tool?: string; name?: string; arguments?: Record<string, unknown> }; toolCalls?: Array<{ tool?: string; name?: string; arguments?: Record<string, unknown> }>; promptBlocks?: string[] }>): string {
    if (!history || !history.length) return "";
    // 若最后一条为当前 user 消息，排除之（只往前追溯真实历史）
    const endIndex = history[history.length - 1]?.role === "user" ? history.length - 2 : history.length - 1;
    for (let index = endIndex; index >= 0; index -= 1) {
        const item = history[index];
        const calls = [
            ...(item.call ? [item.call] : []),
            ...(Array.isArray(item.toolCalls) ? item.toolCalls : []),
        ];
        for (const call of calls) {
            if (call && typeof call === "object") {
                const toolName = (call as { tool?: string; name?: string }).tool || (call as { tool?: string; name?: string }).name;
                const args = (call as { arguments?: Record<string, unknown> }).arguments;
                if (toolName === "generate_image" || toolName === "edit_image" || toolName === "canvas_create_image_node") {
                    const prompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
                    if (prompt) return prompt;
                }
                if (toolName === "canvas_batch_generate_nodes" && Array.isArray(args?.tasks)) {
                    const first = (args.tasks as Array<{ prompt?: string }>)[0];
                    if (first && typeof first.prompt === "string" && first.prompt.trim()) {
                        return first.prompt.trim();
                    }
                }
            }
        }
        if (item.role === "assistant" && Array.isArray(item.promptBlocks) && item.promptBlocks.length) {
            const p = String(item.promptBlocks[0] || "").trim();
            if (p) return p;
        }
        const userText = item.text || item.content;
        if (item.role === "user" && userText) {
            if (REFERENCE_PROMPT_PATTERN.test(userText) || FOLLOW_UP_PATTERN.test(userText) || PURE_INQUIRY_PATTERN.test(userText)) {
                continue;
            }
            const stripped = stripInstructionPrefix(userText);
            if (stripped.length >= 3 && (countVisualCategories(stripped) >= 1 || stripped.length >= 8)) {
                return stripped;
            }
        }
    }
    return "";
}

/**
 * 判定用户本轮意图。
 * 判定顺序：元指令 → 否定 → 填入工作台 → 改图 → 纯用法咨询 → 延续上一轮生成 → 显式生成/拆解 → 上下文延续 → 独立完整提示词 → 聊天。
 */
export function detectAgentIntent(
    text: string,
    options?: { hasReferences?: boolean; history?: Array<{ role: string; text?: string; call?: AgentToolCall; promptBlocks?: string[] }> },
): AgentIntent {
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

    // 历史会话上下文继承检测（例如多轮会话中模型询问偏好，用户后续作答）
    const recentMessages = options?.history ? [...options.history].slice(-4) : [];
    const historyGifContext = recentMessages.some(
        (m) =>
            (m.role === "assistant" && /想要单张.*还是四格|动图|动态表情包|\bgif\b/i.test(m.text || "")) ||
            (m.role === "user" && GIF_INTENT_PATTERN.test(m.text || "")),
    );
    const historyTransparentContext = recentMessages.some(
        (m) => m.role === "user" && TRANSPARENT_INTENT_PATTERN.test(m.text || ""),
    );
    const historyDecomposeContext = recentMessages.some(
        (m) => m.role === "user" && DECOMPOSE_INTENT_PATTERN.test(m.text || ""),
    );
    const historyStickerContext = recentMessages.some(
        (m) => /表情包|微信表情/i.test(m.text || ""),
    );

    const isGif = GIF_INTENT_PATTERN.test(input) || historyGifContext;
    const isTransparent = TRANSPARENT_INTENT_PATTERN.test(input) || historyTransparentContext;
    const isDecompose = DECOMPOSE_INTENT_PATTERN.test(input) || historyDecomposeContext;
    const isCanvas = CANVAS_ACTION_PATTERN.test(input);
    const layout = /并排|横排|横向/i.test(input) ? ("horizontal" as const) : /竖排|纵排|纵向/i.test(input) ? ("vertical" as const) : isCanvas ? ("grid" as const) : undefined;
    const usageScene = detectUsageScene(input) || (!GENERATE_ACTION_PATTERN.test(input) && historyStickerContext ? "微信表情包" : undefined);
    const batchCount = extractBatchCount(input);
    const colonBody = extractColonBody(input);
    const stripped = stripInstructionPrefix(input);
    const isAspectOnly = /^(?:横屏|竖屏|方屏|横版|竖版|方版|宽屏|全屏|壁纸|正方形|长方形|横图|竖图|方图|16:9|9:16|1:1|4:3|3:4|高画质|高清|超清)+(?:的|图)?$/i.test(stripped);
    const inferredSize = inferImageSizeFromPrompt(input, "");

    // ⑤ 纯功能/使用咨询提问（如「怎么用」「支持哪些模型」）→ 聊天
    if (!colonBody && PURE_INQUIRY_PATTERN.test(input)) {
        return CHAT_INTENT;
    }

    // ⑥ 续作/增补上一轮生成（例如「再生成一个」「再来一张」「换个姿势再来一个」「要双爪合十求抱抱」或用户直接选择了上一轮推荐的选项）
    const previousPrompt = findLastGenerationPrompt(options?.history);
    const assistantSuggestions = extractAssistantSuggestions(options?.history);
    const matchesSuggestion = assistantSuggestions.some((s) => input.includes(s) || s.includes(input));
    // 提示词优化/改写类追问不能误判为「继续生成」：如「再优化一版」「润色一下提示词」
    const isPromptRefineRequest =
        /^(?:请|帮我|麻烦)?\s*(?:再|重新|继续)?\s*(?:优化|润色|改写|完善|扩写|精简|调整|重写)/.test(input) &&
        !/(?:生成|出图|画一|画个|画张|来一|做一|做个)/.test(input);
    const isFollowUp = !isPromptRefineRequest && (FOLLOW_UP_PATTERN.test(input) || /^(再来|再出|换一版|换个风格|换个姿势|再生成一次|再来一次)$/.test(input) || matchesSuggestion || isAspectOnly) && Boolean(previousPrompt);
    if (isFollowUp && previousPrompt) {
        const modification = isAspectOnly ? "" : extractFollowUpModification(input);
        const combined = modification ? `${previousPrompt}，${modification}` : previousPrompt;
        return {
            kind: "generate_image",
            prompt: combined,
            explicit: true,
            direct: false,
            ...(isGif ? { format: "gif" as const } : {}),
            ...(inferredSize ? { size: inferredSize } : {}),
            ...(isTransparent ? { background: "transparent" as const } : {}),
            ...(isDecompose ? { decompose: true } : {}),
            ...(isCanvas ? { isCanvas: true } : {}),
            ...(layout ? { layout } : {}),
            ...(usageScene ? { usageScene } : {}),
            ...(batchCount ? { batchCount } : {}),
        };
    }

    // ⑦ 显式生成/创作/设计/拆解动作 → 生成图片
    if (GENERATE_ACTION_PATTERN.test(input)) {
        let prompt = colonBody ?? stripped;
        if ((!prompt || isAspectOnly) && previousPrompt) {
            prompt = previousPrompt;
        } else if (!prompt && countVisualCategories(input) >= 2 && input.length >= 24) {
            prompt = input;
        }
        if (!isAspectOnly) {
            prompt = sanitizeExtractedPrompt(prompt, input);
        }
        if (!prompt && previousPrompt) {
            prompt = previousPrompt;
        }
        // 如果是拆解任务、画布排布任务、或者有明确用途但描述较短，交给模型进行深度分析与拆解规划；若是详细提示词则直接执行
        const direct = Boolean(colonBody && prompt) || (!isDecompose && !isCanvas && (prompt.length >= 24 || countVisualCategories(prompt) >= 2));
        return {
            kind: "generate_image",
            prompt,
            explicit: true,
            direct,
            explicitCommand: Boolean(colonBody && prompt),
            ...(isGif ? { format: "gif" as const } : {}),
            ...(inferredSize ? { size: inferredSize } : {}),
            ...(isTransparent ? { background: "transparent" as const } : {}),
            ...(isDecompose ? { decompose: true } : {}),
            ...(isCanvas ? { isCanvas: true } : {}),
            ...(layout ? { layout } : {}),
            ...(usageScene ? { usageScene } : {}),
            ...(batchCount ? { batchCount } : {}),
        };
    }

    // ⑧ 延续动图上下文的神态偏好回复
    if (historyGifContext && !SMALL_TALK_PATTERN.test(input) && input.length >= 2 && /表情|神态|动作|笑|哭|生气|贴贴|抱抱/.test(input)) {
        return {
            kind: "generate_image",
            prompt: previousPrompt ? `${previousPrompt}，${input}，循环动态动作` : `生动搞怪表情，${input}，循环动态动作`,
            explicit: true,
            direct: false,
            format: "gif",
            ...(isTransparent ? { background: "transparent" as const } : {}),
            ...(usageScene ? { usageScene } : {}),
        };
    }

    // ⑨ 提到提示词但没有明确动作 → 聊天（例如「用这个提示词生成图片」已在⑦命中）
    if (/提示词|prompt/i.test(input)) return CHAT_INTENT;

    // ⑩ 独立完整生图提示词：不是提问/闲聊，长度和画面要素都达标 → 生成图片
    if (
        !SMALL_TALK_PATTERN.test(input) &&
        !PURE_INQUIRY_PATTERN.test(input) &&
        !input.endsWith("?") &&
        !input.endsWith("？") &&
        (
            // 模式 A：长度 >= 20，且命中至少 2 个视觉要素分类
            (input.replace(/\s+/g, "").length >= 20 && countVisualCategories(input) >= 2) ||
            // 模式 B：长段细节场景描述（>= 36 字，且包含视觉要素，非咨询问句）
            (input.replace(/\s+/g, "").length >= 36 && countVisualCategories(input) >= 1)
        )
    ) {
        return {
            kind: "generate_image",
            prompt: input,
            explicit: false,
            direct: true,
            ...(isGif ? { format: "gif" as const } : {}),
            ...(isTransparent ? { background: "transparent" as const } : {}),
            ...(usageScene ? { usageScene } : {}),
        };
    }

    // ⑪ 其余 → 聊天
    return CHAT_INTENT;
}
