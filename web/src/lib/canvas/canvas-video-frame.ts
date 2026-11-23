export type VideoFramePosition = "first" | "last" | "current" | "time";

export type ContactSheetLayout = {
    cols: number;
    rows: number;
    gap: number;
    pad: number;
    cellWidth: number;
    cellHeight: number;
    canvasWidth: number;
    canvasHeight: number;
};

export type EncodedMcpImage = {
    dataBase64: string;
    mimeType: "image/jpeg";
    width: number;
    height: number;
};

export type VideoContactSheetResult = EncodedMcpImage & {
    durationSeconds: number;
    videoWidth: number;
    videoHeight: number;
    timestamps: number[];
};

/** 计算视频均匀抽帧的时间戳（秒），默认 6 帧，范围 3–9 帧。 */
export function computeSampleTimestamps(duration: number, frameCount = 6): number[] {
    const count = Math.max(3, Math.min(9, Math.floor(frameCount || 6)));
    if (!Number.isFinite(duration) || duration <= 0) {
        return Array.from({ length: count }, () => 0);
    }
    const endTime = Math.max(0, duration - Math.min(0.05, duration * 0.05));
    return Array.from({ length: count }, (_, idx) => Number(((endTime * idx) / (count - 1)).toFixed(3)));
}

/** 按比例缩放宽高，使长边不超过 maxEdge。 */
export function fitMaxEdge(width: number, height: number, maxEdge: number): { width: number; height: number } {
    const w = Math.max(1, width || 1);
    const h = Math.max(1, height || 1);
    const limit = Math.max(1, maxEdge || 1280);
    const scale = Math.min(1, limit / Math.max(w, h));
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** 计算多帧接触表或参考图拼图的网格尺寸，确保总画布长边不超过 maxEdge。 */
export function computeContactSheetLayout(itemCount: number, cellAspect: number, maxEdge = 1280): ContactSheetLayout {
    const count = Math.max(1, Math.floor(itemCount || 1));
    const cols = count <= 2 ? count : count <= 4 ? 2 : count <= 9 ? 3 : 4;
    const rows = Math.ceil(count / cols);
    const gap = 6;
    const pad = 6;
    const limit = Math.max(256, maxEdge || 1280);
    const aspect = Number.isFinite(cellAspect) && cellAspect > 0 ? cellAspect : 16 / 9;

    const maxCellW = Math.max(32, (limit - pad * 2 - gap * (cols - 1)) / cols);
    const maxCellH = Math.max(32, (limit - pad * 2 - gap * (rows - 1)) / rows);
    let cellWidth = Math.min(640, maxCellW);
    let cellHeight = cellWidth / aspect;
    if (cellHeight > maxCellH) {
        cellHeight = maxCellH;
        cellWidth = cellHeight * aspect;
    }
    const roundedCellW = Math.max(32, Math.floor(cellWidth));
    const roundedCellH = Math.max(32, Math.floor(cellHeight));
    return {
        cols,
        rows,
        gap,
        pad,
        cellWidth: roundedCellW,
        cellHeight: roundedCellH,
        canvasWidth: cols * roundedCellW + (cols - 1) * gap + pad * 2,
        canvasHeight: rows * roundedCellH + (rows - 1) * gap + pad * 2,
    };
}

export async function captureVideoFrame(source: string, position: VideoFramePosition, currentTime = 0) {
    const video = createOffscreenVideo(source);
    try {
        await waitForVideo(video, "loadedmetadata");
        const endTime = Math.max(0, (video.duration || 0) - 0.001);
        const time = position === "first" ? 0 : position === "last" ? endTime : Math.max(0, Math.min(currentTime, endTime));
        await seekVideoTo(video, time);

        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 1;
        canvas.height = video.videoHeight || 1;
        canvas.getContext("2d")!.drawImage(video, 0, 0);
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("Failed to capture video frame"))), "image/png"));
    } finally {
        disposeOffscreenVideo(video);
    }
}

/** 抽取视频多帧并合成为带时间戳编号的 JPEG 接触表，用于视觉质检。 */
export async function captureVideoContactSheet(source: string, options: { frameCount?: number; maxEdge?: number } = {}): Promise<VideoContactSheetResult> {
    const frameCount = Math.max(3, Math.min(9, Math.floor(options.frameCount || 6)));
    const maxEdge = Math.max(512, Math.min(1280, Math.floor(options.maxEdge || 1280)));
    const video = createOffscreenVideo(source);
    try {
        await waitForVideo(video, "loadedmetadata");
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        const videoWidth = video.videoWidth || 1280;
        const videoHeight = video.videoHeight || 720;
        const timestamps = computeSampleTimestamps(duration, frameCount);
        const layout = computeContactSheetLayout(timestamps.length, videoWidth / videoHeight, maxEdge);

        const canvas = document.createElement("canvas");
        canvas.width = layout.canvasWidth;
        canvas.height = layout.canvasHeight;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#141414";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        for (let i = 0; i < timestamps.length; i += 1) {
            const time = timestamps[i];
            await seekVideoTo(video, time);
            const col = i % layout.cols;
            const row = Math.floor(i / layout.cols);
            const x = layout.pad + col * (layout.cellWidth + layout.gap);
            const y = layout.pad + row * (layout.cellHeight + layout.gap);
            ctx.drawImage(video, x, y, layout.cellWidth, layout.cellHeight);
            drawCellLabel(ctx, x, y, `#${i + 1} ${time.toFixed(1)}s`);
        }

        return {
            ...canvasToJpegBase64(canvas),
            durationSeconds: Number(duration.toFixed(2)),
            videoWidth,
            videoHeight,
            timestamps,
        };
    } finally {
        disposeOffscreenVideo(video);
    }
}

/** 将单张图片按长边限制压缩编码为 JPEG Base64。 */
export async function encodeImageToMcpJpeg(source: string, maxEdge = 1280): Promise<EncodedMcpImage> {
    const img = await loadImageElement(source);
    const { width, height } = fitMaxEdge(img.naturalWidth, img.naturalHeight, maxEdge);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#141414";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return canvasToJpegBase64(canvas);
}

/** 将多张参考图合成为带 [图N] 角标的对照拼图（使用 contain 保留完整人物与构图）。 */
export async function buildReferenceContactSheet(items: Array<{ url: string; label: string }>, maxEdge = 1280): Promise<(EncodedMcpImage & { count: number }) | null> {
    if (!items.length) return null;
    const settled = await Promise.allSettled(items.slice(0, 10).map(async (item) => ({ img: await loadImageElement(item.url), label: item.label })));
    const loaded = settled.filter((r): r is PromiseFulfilledResult<{ img: HTMLImageElement; label: string }> => r.status === "fulfilled").map((r) => r.value);
    if (!loaded.length) return null;

    const layout = computeContactSheetLayout(loaded.length, 1, Math.max(512, Math.min(1280, maxEdge)));
    const canvas = document.createElement("canvas");
    canvas.width = layout.canvasWidth;
    canvas.height = layout.canvasHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#141414";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < loaded.length; i += 1) {
        const { img, label } = loaded[i];
        const col = i % layout.cols;
        const row = Math.floor(i / layout.cols);
        const cellX = layout.pad + col * (layout.cellWidth + layout.gap);
        const cellY = layout.pad + row * (layout.cellHeight + layout.gap);
        ctx.fillStyle = "#1f1e1d";
        ctx.fillRect(cellX, cellY, layout.cellWidth, layout.cellHeight);

        const iw = img.naturalWidth || 1;
        const ih = img.naturalHeight || 1;
        const scale = Math.min(layout.cellWidth / iw, layout.cellHeight / ih);
        const drawW = Math.max(1, Math.round(iw * scale));
        const drawH = Math.max(1, Math.round(ih * scale));
        const drawX = cellX + Math.floor((layout.cellWidth - drawW) / 2);
        const drawY = cellY + Math.floor((layout.cellHeight - drawH) / 2);
        ctx.drawImage(img, drawX, drawY, drawW, drawH);
        drawCellLabel(ctx, cellX, cellY, label);
    }

    return { ...canvasToJpegBase64(canvas), count: loaded.length };
}

function createOffscreenVideo(source: string) {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = source;
    video.load();
    return video;
}

function disposeOffscreenVideo(video: HTMLVideoElement) {
    video.removeAttribute("src");
    video.load();
}

async function seekVideoTo(video: HTMLVideoElement, time: number) {
    if (time > 0) {
        const seeked = waitForVideo(video, "seeked");
        video.currentTime = time;
        await seeked;
    } else if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        await waitForVideo(video, "loadeddata");
    }
}

function drawCellLabel(ctx: CanvasRenderingContext2D, x: number, y: number, text: string) {
    ctx.save();
    ctx.font = "bold 13px sans-serif";
    const metrics = ctx.measureText(text);
    const boxW = Math.ceil(metrics.width) + 12;
    const boxH = 22;
    ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
    ctx.fillRect(x + 6, y + 6, boxW, boxH);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + 12, y + 6 + boxH / 2);
    ctx.restore();
}

function canvasToJpegBase64(canvas: HTMLCanvasElement): EncodedMcpImage {
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    const idx = dataUrl.indexOf(",");
    return {
        dataBase64: idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl,
        mimeType: "image/jpeg",
        width: canvas.width,
        height: canvas.height,
    };
}

function loadImageElement(source: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        if (!source.startsWith("data:") && !source.startsWith("blob:")) {
            img.crossOrigin = "anonymous";
        }
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Failed to load image"));
        img.src = source;
    });
}

function waitForVideo(video: HTMLVideoElement, eventName: "loadedmetadata" | "loadeddata" | "seeked") {
    return new Promise<void>((resolve, reject) => {
        const finish = () => {
            video.removeEventListener(eventName, finish);
            video.removeEventListener("error", fail);
            resolve();
        };
        const fail = () => {
            video.removeEventListener(eventName, finish);
            video.removeEventListener("error", fail);
            reject(new Error("Failed to read video frame"));
        };
        video.addEventListener(eventName, finish);
        video.addEventListener("error", fail);
    });
}
