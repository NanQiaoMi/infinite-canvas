import { describe, expect, test } from "bun:test";

import { guessCapability } from "@/lib/model-capability";

describe("模型能力识别", () => {
    test("图片模型", () => {
        for (const name of ["gpt-image-2", "gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "dall-e-3", "gemini-2.5-flash-image", "grok-imagine", "seedream-4", "flux-1.1-pro", "imagen-4", "nano-banana"]) {
            expect(guessCapability(name)).toBe("image");
        }
    });

    test("视频模型", () => {
        for (const name of ["sora-2", "veo-3", "kling-v2", "wan2.5-i2v", "seedance-1", "hailuo-2", "runway-gen4", "minimax-video-01"]) {
            expect(guessCapability(name)).toBe("video");
        }
    });

    test("音频模型", () => {
        for (const name of ["gpt-4o-mini-tts", "gpt-4o-audio-preview", "whisper-1", "elevenlabs-tts", "suno-v4", "minimax-speech-01"]) {
            expect(guessCapability(name)).toBe("audio");
        }
    });

    test("文本模型（含 chatgpt2api 模型名）", () => {
        for (const name of ["auto", "gpt-5-6", "gpt-5-6-mini", "gpt-6", "gpt-6-mini", "research", "gpt-4o", "gpt-4o-mini", "gpt-5", "gpt-5.6", "o1", "o3-mini", "claude-opus-4-1", "deepseek-chat"]) {
            expect(guessCapability(name)).toBe("text");
        }
    });
});
