const STORAGE_KEY = "infinite-canvas:builtin_fingerprint";
const VISITOR_PREFIX = "fp_";

function fnv1a(input: string): string {
    let hashA = 0x811c9dc5;
    let hashB = 0x01000193;
    for (let index = 0; index < input.length; index += 1) {
        const code = input.charCodeAt(index);
        hashA ^= code;
        hashA = Math.imul(hashA, 0x01000193);
        hashB = Math.imul(hashB ^ code, 0x85ebca6b);
    }
    return `${(hashA >>> 0).toString(16).padStart(8, "0")}${(hashB >>> 0).toString(16).padStart(8, "0")}`;
}

function canvasSignal(): string {
    try {
        const canvas = document.createElement("canvas");
        canvas.width = 240;
        canvas.height = 60;
        const context = canvas.getContext("2d");
        if (!context) return "no-canvas";
        context.textBaseline = "top";
        context.font = "16px 'Arial'";
        context.fillStyle = "#f60";
        context.fillRect(0, 0, 120, 40);
        context.fillStyle = "#069";
        context.fillText("infinite-canvas-fp-测试 2026", 2, 4);
        context.strokeStyle = "rgba(102, 204, 0, 0.7)";
        context.beginPath();
        context.arc(180, 30, 20, 0, Math.PI * 2, true);
        context.stroke();
        return canvas.toDataURL();
    } catch {
        return "canvas-error";
    }
}

function webglSignal(): string {
    try {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        if (!gl) return "no-webgl";
        const context = gl as WebGLRenderingContext;
        const debugInfo = context.getExtension("WEBGL_debug_renderer_info");
        const vendor = debugInfo ? String(context.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)) : "";
        const renderer = debugInfo ? String(context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : "";
        const params = ["MAX_TEXTURE_SIZE", "MAX_VIEWPORT_DIMS", "MAX_RENDERBUFFER_SIZE"]
            .map((name) => {
                try {
                    return String((context.getParameter((context as unknown as Record<string, number>)[name]) as unknown) ?? "");
                } catch {
                    return "";
                }
            })
            .join(",");
        return `${vendor}|${renderer}|${params}`;
    } catch {
        return "webgl-error";
    }
}

function collectSignals(): string {
    const nav = navigator as Navigator & { deviceMemory?: number };
    const timeZone = (() => {
        try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
        } catch {
            return "";
        }
    })();
    return JSON.stringify({
        ua: nav.userAgent,
        languages: nav.languages,
        language: nav.language,
        platform: nav.platform,
        hardwareConcurrency: nav.hardwareConcurrency,
        deviceMemory: nav.deviceMemory,
        timeZone,
        screen: {
            width: screen.width,
            height: screen.height,
            availWidth: screen.availWidth,
            availHeight: screen.availHeight,
            colorDepth: screen.colorDepth,
            pixelRatio: window.devicePixelRatio,
        },
        canvas: canvasSignal(),
        webgl: webglSignal(),
    });
}

function fallbackFingerprint(): string {
    try {
        const cached = window.localStorage.getItem(STORAGE_KEY);
        if (cached && cached.length >= 16) return cached;
    } catch {
        // 忽略隐私模式下的 localStorage 异常。
    }
    const generated = `${VISITOR_PREFIX}${fnv1a(`${Date.now()}-${Math.random()}`)}${fnv1a(String(Math.random()))}`;
    try {
        window.localStorage.setItem(STORAGE_KEY, generated);
    } catch {
        // 忽略。
    }
    return generated;
}

/**
 * 内置轻量浏览器指纹：
 * 采集 UA/语言/时区/屏幕/CPU 核数/canvas/WebGL 渲染信息后做两轮哈希。
 * 仅用于服务端匿名访客额度治理，不做跨站追踪。
 */
export function computeBrowserFingerprint(): { visitorId: string; source: "builtin" } {
    try {
        const signals = collectSignals();
        const hashed = `${fnv1a(signals)}${fnv1a(signals.split("").reverse().join(""))}`;
        if (!hashed || /^0+$/.test(hashed)) return { visitorId: fallbackFingerprint(), source: "builtin" };
        return { visitorId: `${VISITOR_PREFIX}${hashed}`, source: "builtin" };
    } catch {
        return { visitorId: fallbackFingerprint(), source: "builtin" };
    }
}
