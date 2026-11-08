import { describe, expect, test } from "bun:test";

import { CHAT_INTENT, detectAgentIntent } from "@/lib/conversation-agent/intent";

/** 用户直接粘贴的完整生图提示词：只描述画面，没有任何「写/优化/评价」类请求。 */
const JK_PROMPT =
    "真实摄影风格的日系JK少女，站在樱花飘落的校园小路上，白色水手服搭配百褶裙，回眸看向镜头微笑，50mm镜头，浅景深，自然光从侧面照来，柔和的光斑背景，胶片质感，细节丰富，避免过度磨皮和塑料感，8K高清。";

describe("本地意图识别", () => {
    test("完整 JK 生图提示词直接判定为生成图片并直连执行", () => {
        const intent = detectAgentIntent(JK_PROMPT, { hasReferences: false });
        expect(intent.kind).toBe("generate_image");
        expect(intent.direct).toBe(true);
        expect(intent.explicit).toBe(false);
        expect(intent.prompt).toBe(JK_PROMPT);
    });

    test("「生成图片：<完整提示词>」直连执行并去掉指令前缀", () => {
        const intent = detectAgentIntent(`生成图片：${JK_PROMPT}`, { hasReferences: false });
        expect(intent.kind).toBe("generate_image");
        expect(intent.direct).toBe(true);
        expect(intent.explicit).toBe(true);
        expect(intent.prompt).toBe(JK_PROMPT);
    });

    test("提示词优化/编写/评价类元指令仍然走聊天", () => {
        const samples = [
            `帮我优化这段提示词：${JK_PROMPT}`,
            "写一个赛博朋克夜景的提示词",
            "这个提示词怎么样？",
            "帮我评价一下这段提示词的光线描述。",
            "refine this prompt: a cat sitting on a windowsill",
            "帮我写一个生图提示词：日系少女",
        ];
        for (const text of samples) {
            expect(detectAgentIntent(text, { hasReferences: false })).toBe(CHAT_INTENT);
        }
    });

    test("明确否定生成时走聊天", () => {
        expect(detectAgentIntent("不要生成图片，只给我提示词").kind).toBe("chat");
        expect(detectAgentIntent("只写提示词就行，先别出图").kind).toBe("chat");
    });

    test("帮助/用法类提问即使带「生图/生成图片」字样也走聊天", () => {
        const samples = [
            "如何生成图片？",
            "怎么生图？",
            "生图工作台怎么用？",
            "生图工作台在哪",
            "生图和视频工作台有什么区别？",
            "打开生图工作台",
            "生成图片要多久？",
            "请问怎么把图片保存下来？",
        ];
        for (const text of samples) {
            expect(detectAgentIntent(text, { hasReferences: false })).toBe(CHAT_INTENT);
        }
    });

    test("冒号形式不受提问短路影响", () => {
        const intent = detectAgentIntent("生成图片：一只猫？", { hasReferences: false });
        expect(intent.kind).toBe("generate_image");
        expect(intent.direct).toBe(true);
        expect(intent.prompt).toBe("一只猫？");
    });

    test("冒号后显式给出的完整提示词不被指代清理误删", () => {
        const bodies = [
            "这个女孩站在樱花树下，白色水手服，50mm镜头，浅景深，胶片质感",
            "之前下过雨的城市街道，霓虹灯，电影感",
            "参考图画风，赛博朋克城市夜景，霓虹灯，电影感",
        ];
        for (const body of bodies) {
            const intent = detectAgentIntent(`生成图片：${body}`, { hasReferences: false });
            expect(intent.kind).toBe("generate_image");
            expect(intent.direct).toBe(true);
            expect(intent.prompt).toBe(body);
        }
    });

    test("模糊生成需求不直连，交给模型代写提示词", () => {
        const intent = detectAgentIntent("帮我生成一张赛博朋克海报", { hasReferences: false });
        expect(intent.kind).toBe("generate_image");
        expect(intent.explicit).toBe(true);
        expect(intent.direct).toBe(false);
        expect(intent.prompt).toBe("赛博朋克海报");
    });

    test("英文生成动作可识别", () => {
        const intent = detectAgentIntent("generate an image of a cat", { hasReferences: false });
        expect(intent.kind).toBe("generate_image");
        expect(intent.explicit).toBe(true);
        expect(intent.direct).toBe(false);
        expect(intent.prompt).toBe("a cat");
    });

    test("「用这个提示词生成图片」按生成处理，指代文本不当作提示词", () => {
        const intent = detectAgentIntent("用这个提示词生成图片", { hasReferences: false });
        expect(intent.kind).toBe("generate_image");
        expect(intent.explicit).toBe(true);
        expect(intent.prompt).toBe("");
    });

    test("指代型/续作型生成请求的提示词留空，交给运行时用历史提示词兜底", () => {
        for (const text of ["重新生成这张图", "再生成一版", "按照上面那个提示词再来一版"]) {
            const intent = detectAgentIntent(text, { hasReferences: false });
            expect(intent.kind).toBe("generate_image");
            expect(intent.prompt).toBe("");
        }
    });

    test("比例冒号不当作指令分隔符，prompt 完整保留 16:9", () => {
        const intent = detectAgentIntent("帮我生成一张16:9的横图，赛博朋克城市夜景", { hasReferences: false });
        expect(intent.kind).toBe("generate_image");
        expect(intent.prompt).toContain("16:9");
        expect(intent.prompt).toBe("16:9的横图，赛博朋克城市夜景");
    });

    test("生成动作容忍数字与空格量词", () => {
        const intent = detectAgentIntent("生成 2 张 赛博朋克", { hasReferences: false });
        expect(intent.kind).toBe("generate_image");
        expect(intent.explicit).toBe(true);
        expect(intent.prompt).toBe("赛博朋克");
        expect(detectAgentIntent("生成2张", { hasReferences: false }).kind).toBe("generate_image");
        expect(detectAgentIntent("生成 一张 赛博朋克", { hasReferences: false }).prompt).toBe("赛博朋克");
        expect(detectAgentIntent("出 2 张图", { hasReferences: false }).kind).toBe("generate_image");
    });

    test("有参考图的改图指令直接改图，无参考图不误判", () => {
        const edit = detectAgentIntent("把背景改成深蓝色", { hasReferences: true });
        expect(edit.kind).toBe("edit_image");
        expect(edit.direct).toBe(true);
        expect(edit.prompt).toBe("把背景改成深蓝色");
        expect(detectAgentIntent("把背景改成深蓝色", { hasReferences: false }).kind).toBe("chat");
    });

    test("填入工作台走 apply_prompt", () => {
        const intent = detectAgentIntent("填入生图工作台", { hasReferences: false });
        expect(intent.kind).toBe("apply_prompt");
        expect(intent.direct).toBe(false);
        expect(intent.prompt).toBe("");
    });

    test("闲聊、提问、普通文本走聊天", () => {
        for (const text of ["你好", "今天天气不错", "今天几号？", "这段提示词里的光影不错"]) {
            expect(detectAgentIntent(text, { hasReferences: false }).kind).toBe("chat");
        }
    });

    test("英文完整提示词同样直连出图", () => {
        const text = "A cinematic photo of a young woman in a school uniform standing under cherry blossoms, 50mm lens, shallow depth of field, soft natural light, film grain, highly detailed.";
        const intent = detectAgentIntent(text, { hasReferences: false });
        expect(intent.kind).toBe("generate_image");
        expect(intent.direct).toBe(true);
        expect(intent.prompt).toBe(text);
    });

    test("动图与 GIF 意图准确识别", () => {
        const gif1 = detectAgentIntent("生成一个猫咪动图", { hasReferences: false });
        expect(gif1.kind).toBe("generate_image");
        expect(gif1.format).toBe("gif");

        const gif2 = detectAgentIntent("做个搞笑猫咪gif表情包", { hasReferences: false });
        expect(gif2.kind).toBe("generate_image");
        expect(gif2.format).toBe("gif");

        const gif3 = detectAgentIntent("来个动态表情包：邪魅坏笑的橘猫", { hasReferences: false });
        expect(gif3.kind).toBe("generate_image");
        expect(gif3.format).toBe("gif");
        expect(gif3.prompt).toBe("邪魅坏笑的橘猫");

        const gif4 = detectAgentIntent("generate an animated gif of a cat running", { hasReferences: false });
        expect(gif4.kind).toBe("generate_image");
        expect(gif4.format).toBe("gif");
    });

    test("透明底与 PNG 透明图片意图准确识别", () => {
        const trans1 = detectAgentIntent("生成png透明图片", { hasReferences: false });
        expect(trans1.kind).toBe("generate_image");
        expect(trans1.background).toBe("transparent");

        const trans2 = detectAgentIntent("生成一个透明底的苹果图标", { hasReferences: false });
        expect(trans2.kind).toBe("generate_image");
        expect(trans2.background).toBe("transparent");

        const trans3 = detectAgentIntent("generate a transparent png of a cute character", { hasReferences: false });
        expect(trans3.kind).toBe("generate_image");
        expect(trans3.background).toBe("transparent");
    });

    test("礼貌请求式问句准确识别为生成请求，不被误判为咨询聊天", () => {
        const samples = [
            "能不能帮我画一个戴眼镜的柴犬？",
            "可以帮我做一张海报吗？",
            "请问能生成一张科技感壁纸吗？",
            "可以为我设计一个动漫头像吗？",
            "能不能做个透明底的水果图标？",
        ];
        for (const text of samples) {
            const intent = detectAgentIntent(text, { hasReferences: false });
            expect(intent.kind).toBe("generate_image");
            expect(intent.explicit).toBe(true);
        }
    });

    test("用户用途场景与业务定位准确提取", () => {
        const xiaohongshu = detectAgentIntent("我想做一张小红书美妆推广图");
        expect(xiaohongshu.kind).toBe("generate_image");
        expect(xiaohongshu.usageScene).toContain("小红书");

        const ecommerce = detectAgentIntent("做一张电商白底产品图：香水瓶特写");
        expect(ecommerce.kind).toBe("generate_image");
        expect(ecommerce.usageScene).toContain("电商产品");

        const emoji = detectAgentIntent("帮我做一套微信日常表情包");
        expect(emoji.kind).toBe("generate_image");
        expect(emoji.usageScene).toContain("微信表情包");

        const logo = detectAgentIntent("帮我设计一个科技感极简Logo");
        expect(logo.kind).toBe("generate_image");
        expect(logo.usageScene).toContain("Logo/图标");
    });

    test("任务拆解与批量生成意图准确识别", () => {
        const decomposeSample = detectAgentIntent("把海报拆解为多次透明底素材生成");
        expect(decomposeSample.kind).toBe("generate_image");
        expect(decomposeSample.decompose).toBe(true);
        expect(decomposeSample.background).toBe("transparent");

        const batchSample = detectAgentIntent("批量生成 4 张赛博机甲头像并在画布排开");
        expect(batchSample.kind).toBe("generate_image");
        expect(batchSample.decompose).toBe(true);
        expect(batchSample.batchCount).toBe(4);

        const suiteSample = detectAgentIntent("帮我做一套中秋节海报素材，拆解为主体和背景");
        expect(suiteSample.kind).toBe("generate_image");
        expect(suiteSample.decompose).toBe(true);
    });

    test("「要双爪合十求抱抱」及助手推荐选项能够准确识别为延续生图意图", () => {
        const history = [
            { role: "user", text: "生成一只可爱的橘白小猫，阳光草地背景" },
            {
                role: "assistant",
                text: "🐈 已生成一只可爱的橘白小猫！采用写实摄影风格。你还可以尝试更可爱！摸摸」或者「双爪合十求抱抱」！",
                promptBlocks: ["一只可爱的橘白小猫，阳光草地背景，大眼睛软萌"],
            },
        ];
        const intent = detectAgentIntent("要双爪合十求抱抱", { history });
        expect(intent.kind).toBe("generate_image");
        expect(intent.prompt).toContain("一只可爱的橘白小猫");
        expect(intent.prompt).toContain("双爪合十求抱抱");

        const intentDirectChoice = detectAgentIntent("双爪合十求抱抱", { history });
        expect(intentDirectChoice.kind).toBe("generate_image");
        expect(intentDirectChoice.prompt).toContain("一只可爱的橘白小猫");
    });

    test("普通生图不误注入「微信表情包」预设场景，且批量与次数修饰准确剥离", () => {
        // 1. 普通萌宠描述不强行设定为微信表情包
        const catIntent = detectAgentIntent("生成一个大大撒娇的橘猫 不同状态的");
        expect(catIntent.kind).toBe("generate_image");
        expect(catIntent.usageScene).toBeUndefined();

        // 2. 「再生成一次，共5张」准确提取 batchCount: 5，且不残留「一次，共5张」前缀
        const history = [
            { role: "user", text: "生成一个大大撒娇的橘猫 不同状态的" },
            {
                role: "assistant",
                text: "已生成一只胖橘猫",
                promptBlocks: ["圆滚滚胖橘猫，大脑袋小短腿，软萌肉垫，撒娇动作"],
            },
        ];
        const rerunIntent = detectAgentIntent("再生成一次，共5张", { history });
        expect(rerunIntent.kind).toBe("generate_image");
        expect(rerunIntent.batchCount).toBe(5);
        expect(rerunIntent.prompt).toContain("圆滚滚胖橘猫");
        expect(rerunIntent.prompt).not.toContain("一次，共5张");
        expect(rerunIntent.prompt).not.toContain("共5张");
    });

    test("批量生成数量上限扩展至 12，且支持阿拉伯数字与中文数字", () => {
        // 阿拉伯数字 10、12
        const tenSample = detectAgentIntent("批量生成10张不同姿态的柴犬并在画布排开");
        expect(tenSample.batchCount).toBe(10);
        expect(tenSample.decompose).toBe(true);

        const twelveSample = detectAgentIntent("在画布批量生成12张生肖图标");
        expect(twelveSample.batchCount).toBe(12);
        expect(twelveSample.decompose).toBe(true);

        // 中文数字「十张」「十二张」
        const cnTenSample = detectAgentIntent("生成一套十个奇幻魔法药水图标");
        expect(cnTenSample.batchCount).toBe(10);

        const cnTwelveSample = detectAgentIntent("在画布上生成十二张星空插画");
        expect(cnTwelveSample.batchCount).toBe(12);

        // 超过上限的安全限制到 12
        const overflowSample = detectAgentIntent("批量生成20张复古胶片街拍");
        expect(overflowSample.batchCount).toBe(12);
    });

    test("公众人物与生动工作场所场景描述精准识别为独立生图意图", () => {
        const prompt = "山姆·奥特曼、唐纳德·特朗普和埃隆·马斯克在一家繁忙电影院的柜台后面工作";
        const intent = detectAgentIntent(prompt);
        expect(intent.kind).toBe("generate_image");
        expect(intent.prompt).toBe(prompt);
        expect(intent.direct).toBe(true);
    });

    test("冒号显式命令标记 explicitCommand，自然语言生成不标记", () => {
        const colon = detectAgentIntent("生成图片：一只红色苹果，高光", { hasReferences: false });
        expect(colon.kind).toBe("generate_image");
        expect(colon.explicitCommand).toBe(true);

        const natural = detectAgentIntent("帮我生成一张赛博朋克海报", { hasReferences: false });
        expect(natural.kind).toBe("generate_image");
        expect(natural.explicitCommand).toBe(false);
    });

    test("提示词优化类追问不会被误判为继续生成", () => {
        const history = [{ role: "assistant", text: "优化版提示词：雨夜霓虹街道上的撑伞少女，电影感光影" }];
        const refine = detectAgentIntent("再优化一版，更暗黑电影感", { hasReferences: false, history });
        expect(refine.kind).toBe("chat");

        const followUp = detectAgentIntent("再来一张，换个风格", { hasReferences: false, history });
        expect(followUp.kind).toBe("generate_image");
    });

    test("模糊短句：有画面描述按生成意图，无意义短语不提取提示词", () => {
        const catPicture = detectAgentIntent("一张猫的图", { hasReferences: false });
        expect(catPicture.kind).toBe("generate_image");
        expect(catPicture.prompt).toBe("一张猫的图");

        const scene = detectAgentIntent("雨夜街道上的少女", { hasReferences: false });
        expect(scene.kind).toBe("generate_image");
        expect(scene.explicit).toBe(false);

        expect(detectAgentIntent("画一个", { hasReferences: false }).kind).toBe("chat");
        expect(detectAgentIntent("随便来一张", { hasReferences: false }).prompt).toBe("");
        expect(detectAgentIntent("帮我优化一下", { hasReferences: false }).kind).toBe("chat");
        // 文案/标题类写作请求不能被短场景规则误判成生成图片
        expect(detectAgentIntent("帮我写一句 10 字以内的公众号标题，主题是冬日咖啡", { hasReferences: false }).kind).toBe("chat");
        expect(detectAgentIntent("写一句冬日咖啡的文案", { hasReferences: false }).kind).toBe("chat");
        expect(detectAgentIntent("写实风格少女", { hasReferences: false }).kind).toBe("generate_image");
    });
});
