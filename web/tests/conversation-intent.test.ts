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
});
