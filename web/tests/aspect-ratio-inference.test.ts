import { describe, expect, it } from "bun:test";
import { inferImageSizeFromPrompt } from "../src/lib/conversation-agent/aspect-ratio";

describe("inferImageSizeFromPrompt - 智能画幅比例推断", () => {
    it("显式提取提示词中的数字比例（如 16:9, 9:16, 3:4）", () => {
        expect(inferImageSizeFromPrompt("生成一张赛博朋克城市夜景 16:9 高清画质")).toBe("1536x864");
        expect(inferImageSizeFromPrompt("动漫少女樱花 9:16 唯美")).toBe("864x1536");
        expect(inferImageSizeFromPrompt("商业摄影产品图 3:4 极简")).toBe("768x1024");
        expect(inferImageSizeFromPrompt("复古胶片 4:3 纪实")).toBe("1024x768");
        expect(inferImageSizeFromPrompt("超宽银幕 21:9 电影大片")).toBe("2016x864");
    });

    it("智能识别手机壁纸/竖屏场景为 9:16 (864x1536)", () => {
        expect(inferImageSizeFromPrompt("生成一张动漫少女樱花主题壁纸，竖屏唯美")).toBe("864x1536");
        expect(inferImageSizeFromPrompt("做一张手机壁纸，可爱猫咪在阳光下")).toBe("864x1536");
        expect(inferImageSizeFromPrompt("二次元立绘全身照，水手服少女")).toBe("864x1536");
    });

    it("智能识别电脑桌面/横屏/全景场景为 16:9 (1536x864)", () => {
        expect(inferImageSizeFromPrompt("生成一张电脑壁纸，宏大雪山星空全景")).toBe("1536x864");
        expect(inferImageSizeFromPrompt("横屏电影感大片，东京街头霓虹夜景")).toBe("1536x864");
        expect(inferImageSizeFromPrompt("桌面壁纸，赛博朋克飞船穿梭在云层中")).toBe("1536x864");
    });

    it("智能识别头像/Logo 为 1:1 (1024x1024)", () => {
        expect(inferImageSizeFromPrompt("帮我生成一个可爱的柴犬微信头像")).toBe("1024x1024");
        expect(inferImageSizeFromPrompt("科技公司 Logo 设计，极简未来感")).toBe("1024x1024");
    });

    it("智能识别宣传海报/模特写真为 3:4 (768x1024)", () => {
        expect(inferImageSizeFromPrompt("设计一张 1980 年代复古宣传海报")).toBe("768x1024");
        expect(inferImageSizeFromPrompt("秋季女装模特穿搭街拍摄真")).toBe("768x1024");
    });

    it("泛指壁纸时结合主体智能分流", () => {
        // 人物/少女偏手机竖屏
        expect(inferImageSizeFromPrompt("动漫二次元少女壁纸")).toBe("864x1536");
        // 风景/宇宙偏电脑宽屏
        expect(inferImageSizeFromPrompt("深邃宇宙银河星云壁纸")).toBe("1536x864");
    });

    it("基于主体视觉构图语义自适应推断画幅（AI 深度构图分析）", () => {
        // 横向广阔场景（无壁纸或横屏字样，纯场景特征）
        expect(inferImageSizeFromPrompt("一只雄鹰在苍茫群山与雪峰间翱翔，航拍俯瞰")).toBe("1536x864");
        expect(inferImageSizeFromPrompt("落日余晖下的金色海滩，潮水缓缓漫过细沙，地平线延伸")).toBe("1536x864");
        expect(inferImageSizeFromPrompt("深邃银河横跨夜空，戈壁公路无尽延伸")).toBe("1536x864");

        // 纵向修长主体（无竖屏字样，纯人物站立/修长结构）
        expect(inferImageSizeFromPrompt("红衣少女手持长剑亭亭玉立，修长身材，汉服长裙随风飘逸")).toBe("864x1536");
        expect(inferImageSizeFromPrompt("摩天大楼直插云霄，仰视仰拍视角")).toBe("864x1536");

        // 中心聚焦/特写/表情
        expect(inferImageSizeFromPrompt("猫咪面部特写，水汪汪的大眼睛和胡须微距")).toBe("1024x1024");
        expect(inferImageSizeFromPrompt("搞怪猫咪表情包，斜视坏笑")).toBe("1024x1024");
    });

    it("无明显场景倾向时使用 fallback 或 1024x1024", () => {
        expect(inferImageSizeFromPrompt("一只红色苹果，白色背景")).toBe("1024x1024");
        expect(inferImageSizeFromPrompt("一只小狗", "1024x1024")).toBe("1024x1024");
    });
});
