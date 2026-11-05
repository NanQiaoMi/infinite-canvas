export type InferredCapability = "image" | "video" | "text" | "audio";

// 按模型名推断能力：先视频/音频（避免 "gpt-4o-audio-preview"、"wan2.5-i2v" 被误判），再图片，最后文本。
const VIDEO_MODEL_PATTERN =
    /(video|sora|veo|kling|hailuo|seedance|runway|pika|cogvideo|mochi|i2v|t2v|wanx|wan\d|hunyuan-video|minimax[-_ ]?video)/i;
const AUDIO_MODEL_PATTERN =
    /(audio|tts|speech|voice|music|sound|whisper|transcrib|suno|elevenlabs|cosyvoice|chattts|fish[-_ ]?audio|minimax[-_ ]?speech)/i;
const IMAGE_MODEL_PATTERN =
    /(image|imagine|dall[-_ ]?e|imagen|flux|sdxl|sd3|stable[-_ ]?diffusion|midjourney|seedream|seededit|kolors|recraft|ideogram|pixart|nano[-_ ]?banana|banana|cogview|janus|qwen[-_ ]?image|grok[-_ ]?image|firefly|t2i|i2i|playground[-_ ]?v|photon)/i;

/** Best-effort default capability for a freshly fetched model name; user can override in the channel editor. */
export function guessCapability(name: string): InferredCapability {
    const value = name.trim().toLowerCase();
    if (!value) return "text";
    if (VIDEO_MODEL_PATTERN.test(value)) return "video";
    if (AUDIO_MODEL_PATTERN.test(value)) return "audio";
    if (IMAGE_MODEL_PATTERN.test(value)) return "image";
    return "text";
}
