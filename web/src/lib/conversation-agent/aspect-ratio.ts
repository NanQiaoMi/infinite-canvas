/**
 * 智能画幅比例推断模块：
 * 根据用户输入的提示词内容与创作场景，智能推断最适合的图片尺寸与画幅比例，
 * 避免所有图片都死板地使用默认的 1:1（1024x1024）。
 */

export const ASPECT_RATIO_PRESETS: Record<string, string> = {
    "1:1": "1024x1024",
    "16:9": "1536x864",
    "9:16": "864x1536",
    "4:3": "1024x768",
    "3:4": "768x1024",
    "3:2": "1536x1024",
    "2:3": "1024x1536",
    "21:9": "2016x864",
};

/** 显式比例正则（如 16:9, 9:16, 16/9 等） */
const EXPLICIT_RATIO_PATTERN = /\b(16[:/]9|9[:/]16|4[:/]3|3[:/]4|3[:/]2|2[:/]3|1[:/]1|21[:/]9)\b/i;

/** 9:16 极佳适配场景：手机壁纸、竖屏、立绘、全身穿搭、手机屏保 */
const MOBILE_VERTICAL_PATTERNS = [
    /手机壁纸|手机屏保|锁屏|竖屏|竖版|竖图|立绘|全身照|手机壳|小红书|抖音|竖幅/i,
    /phone\s*wallpaper|mobile\s*wallpaper|vertical\s*wallpaper|portrait\s*orientation|vertical\s*screen/i,
];

/** 16:9 极佳适配场景：电脑壁纸、横屏、电影感大片、风景全景、宽屏、设计稿/桌面端 */
const DESKTOP_HORIZONTAL_PATTERNS = [
    /电脑壁纸|桌面壁纸|pc壁纸|横屏|横版|横图|宽屏|宽幅|全景|电影感|横幅|风景大片|宽银幕|设计稿|桌面端|网页设计|网站设计/i,
    /desktop\s*wallpaper|pc\s*wallpaper|widescreen|cinematic\s*(?:shot|view|frame)?|landscape\s*orientation|ui\s*design/i,
];

/** 3:4 / 2:3 适配场景：海报、人像写真、模特穿搭、传统封面 */
const POSTER_PORTRAIT_PATTERNS = [
    /海报|宣传海报|海报设计|写真|人像写真|模特穿搭|街拍|电商主图|封面/i,
    /poster|portrait\s*(?:photography|photo)|fashion\s*lookbook|cover\s*art/i,
];

/** 1:1 适配场景：头像、Logo、图标、标志、正方形贴纸 */
const SQUARE_AVATAR_PATTERNS = [
    /头像|微信头像|社媒头像|icon|logo|标志|徽章|贴纸|正方形|方形/i,
    /avatar|profile\s*picture|square\s*icon|app\s*icon|sticker/i,
];

/** 超宽屏 21:9 */
const ULTRAWIDE_PATTERNS = [/超宽屏|带鱼屏|电影宽银幕|ultrawide|cinemascope/i];

/** 横向广阔场景语义特征（天然适合 16:9 宽屏） */
const HORIZONTAL_SCENIC_SEMANTICS = [
    /群山|山脉|雪山|峰峦|山峦|大草原|平原|荒漠|沙漠|戈壁|海滩|海岸|沙滩|海洋|海浪|海面|湖泊|江河|天际线|地平线|全景|广角|远景|俯瞰|鸟瞰|航拍|星空|银河|极光|云海|夕阳余晖|日落余晖|日出|驾驶舱|街道全景|城市风光|夜景全貌|公路延伸|赛博朋克城市/i,
    /landscape|panorama|panoramic|widescreen|mountains?|ocean|sea|horizon|coast|desert|galaxy|milky way|aurora|skyline|bird'?s[- ]eye|aerial view/i,
];

/** 纵向修长主体语义特征（天然适合 9:16 或 3:4 竖屏） */
const VERTICAL_SUBJECT_SEMANTICS = [
    /全身|立绘|站立|站姿|亭亭玉立|修长|高耸|摩天大楼|参天|瀑布|飞流|长裙|旗袍|和服|汉服|风衣|大衣|全身穿搭|模特走秀|跳跃身姿|直插云霄|高塔/i,
    /full[- ]body|standing|statuesque|towering|skyscraper|waterfall|fashion model|runway/i,
];

/** 适合 1:1 中心聚焦的主体（特写、徽标、单体） */
const SQUARE_FOCUS_SEMANTICS = [
    /特写|面部特写|眼神特写|微距|大头照|表情包|单体静物|logo|icon|头像|徽章|徽标|贴纸|圆形印章/i,
    /close[- ]?up|macro|profile|avatar|emoticon|meme|sticker/i,
];

/**
 * 从提示词文本中智能推断最佳生图尺寸：
 * 1. 优先提取显式标注的比例（如 16:9、9:16、3:4 等）；
 * 2. 匹配具体场景倾向（手机壁纸 -> 9:16，电脑壁纸/电影感 -> 16:9，海报/写真 -> 3:4，头像/图标 -> 1:1）；
 * 3. 泛指“壁纸”时根据主体（人物偏竖屏 9:16，风景/城市偏横屏 16:9）合理推导；
 * 4. 无法命中时回退到 fallbackSize（若有效），最终保底 1024x1024。
 */
export function inferImageSizeFromPrompt(prompt: string, fallbackSize?: string): string {
    const text = String(prompt || "").trim();
    if (!text) {
        return fallbackSize && fallbackSize !== "auto" ? fallbackSize : "1024x1024";
    }

    // 1. 显式比例提取
    const explicitMatch = text.match(EXPLICIT_RATIO_PATTERN);
    if (explicitMatch) {
        const normalized = explicitMatch[1].replace("/", ":");
        if (ASPECT_RATIO_PRESETS[normalized]) {
            return ASPECT_RATIO_PRESETS[normalized];
        }
    }

    // 2. 超宽屏 21:9
    if (ULTRAWIDE_PATTERNS.some((p) => p.test(text))) {
        return ASPECT_RATIO_PRESETS["21:9"];
    }

    // 3. 手机竖屏 9:16
    if (MOBILE_VERTICAL_PATTERNS.some((p) => p.test(text))) {
        return ASPECT_RATIO_PRESETS["9:16"];
    }

    // 4. 电脑横屏 16:9
    if (DESKTOP_HORIZONTAL_PATTERNS.some((p) => p.test(text))) {
        return ASPECT_RATIO_PRESETS["16:9"];
    }

    // 5. 头像/图标 1:1
    if (SQUARE_AVATAR_PATTERNS.some((p) => p.test(text))) {
        return ASPECT_RATIO_PRESETS["1:1"];
    }

    // 6. 海报/写真 3:4
    if (POSTER_PORTRAIT_PATTERNS.some((p) => p.test(text))) {
        return ASPECT_RATIO_PRESETS["3:4"];
    }

    // 7. 泛指“壁纸”/“wallpaper”：结合上下文主体做二次分流
    if (/壁纸|wallpaper/i.test(text)) {
        // 如果包含人物、少女、女孩、角色等，更偏向手机锁屏壁纸 9:16
        if (/少女|女孩|女生|人物|角色|动漫|二次元|二次元少女|jk|girl|anime|character/i.test(text)) {
            return ASPECT_RATIO_PRESETS["9:16"];
        }
        // 如果包含风景、自然、宇宙、星空、城市、赛博朋克等，更偏向电脑横屏壁纸 16:9
        return ASPECT_RATIO_PRESETS["16:9"];
    }

    // 8. 主体深度构图语义分析（AI 视觉特征自适应推导）
    // (a) 横向广阔场景 -> 16:9
    if (HORIZONTAL_SCENIC_SEMANTICS.some((p) => p.test(text))) {
        return ASPECT_RATIO_PRESETS["16:9"];
    }
    // (b) 纵向修长主体/立绘/全身 -> 9:16
    if (VERTICAL_SUBJECT_SEMANTICS.some((p) => p.test(text))) {
        return ASPECT_RATIO_PRESETS["9:16"];
    }
    // (c) 中心特写/单体/表情 -> 1:1
    if (SQUARE_FOCUS_SEMANTICS.some((p) => p.test(text))) {
        return ASPECT_RATIO_PRESETS["1:1"];
    }

    // 9. 默认回退
    if (fallbackSize && fallbackSize.trim() && fallbackSize.toLowerCase() !== "auto") {
        return fallbackSize.trim();
    }
    return "1024x1024";
}
