import { useEffect, useRef } from "react";

type ChatGptDotMatrixProps = {
    aspect?: number;
    className?: string;
};

/**
 * ChatGPT DALL-E 3 官方同款极简纯单色波浪点阵（Dot Matrix Wave）：
 * - 纯单色暖石墨（浅色模式：#78716c / 深色模式：#a8a29e），与暖石底色同一语言，绝不掺杂彩斑杂色；
 * - 严格对齐网格阵列，同频驱动波点半径（0.8px ~ 3.2px）与不透明度（0.04 ~ 0.95）；
 * - 波浪自左上方（圆心向外）如水波涟漪般平滑推进，波峰处波点饱满凝聚，波谷处展现开阔纯净留白；
 * - 完美复现 ChatGPT 参考图 1 的宁静、高级科技美感。
 */
export function ChatGptDotMatrix({ aspect = 1, className }: ChatGptDotMatrixProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d", { alpha: true });
        if (!ctx) return;

        let animId: number;
        let startTime = performance.now();
        let isRunning = true;

        const render = (now: number) => {
            if (!isRunning) return;

            const rect = canvas.getBoundingClientRect();
            const width = rect.width;
            const height = rect.height;

            if (width === 0 || height === 0) {
                animId = requestAnimationFrame(render);
                return;
            }

            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const targetWidth = Math.round(width * dpr);
            const targetHeight = Math.round(height * dpr);

            if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
                canvas.width = targetWidth;
                canvas.height = targetHeight;
            }

            ctx.save();
            ctx.scale(dpr, dpr);
            ctx.clearRect(0, 0, width, height);

            const isDark = document.documentElement.classList.contains("dark");
            const time = (now - startTime) / 1000;

            // 根据宽高比动态计算网格列数与行数（视觉密度严丝合缝对齐 ChatGPT 截图）
            const baseCount = 24;
            const cols = aspect >= 1 ? Math.round(baseCount * Math.min(1.35, Math.sqrt(aspect))) : Math.max(16, Math.round(baseCount * aspect));
            const rows = aspect <= 1 ? Math.round(baseCount / Math.min(1.35, Math.sqrt(aspect))) : Math.max(16, Math.round(baseCount / aspect));

            const padX = width * 0.07;
            const padY = height * 0.07;
            const stepX = (width - padX * 2) / (cols - 1);
            const stepY = (height - padY * 2) / (rows - 1);

            // 严格纯单色暖石墨（无任何蓝/桃红/鹅黄/薰衣草紫等杂色）
            const rBase = isDark ? 168 : 120;
            const gBase = isDark ? 162 : 113;
            const bBase = isDark ? 158 : 108;

            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const x = padX + c * stepX;
                    const y = padY + r * stepY;

                    const normCol = c / (cols - 1);
                    const normRow = r / (rows - 1);

                    // 涟漪水波波源位于左上方微偏外侧 (-0.08, -0.08)
                    // 产生自左上方朝右下方平滑扩展的同心弧面波
                    const dist = Math.hypot(normCol + 0.08, normRow + 0.08);

                    // 空间波数让画面内呈现约 1.5 个波峰周期（左上一波，右下一波，中间开阔空白）
                    const phase = dist * Math.PI * 2.7 - time * 2.5;
                    const rawWave = Math.sin(phase);

                    // 波峰整形：强化波峰凝聚，让波谷平滑隐匿
                    const crest = Math.max(0, (rawWave + 0.3) / 1.3);
                    const crestCurve = Math.pow(crest, 2.2);

                    // 四周边缘正弦微衰减，防止波点生硬贴边
                    const edgeFade = Math.sin(normCol * Math.PI) * Math.sin(normRow * Math.PI);
                    const edgeFactor = Math.pow(edgeFade, 0.2);

                    const waveFactor = crestCurve * edgeFactor;

                    // 严格纯单色波动：浪尖深邃饱满 (3.2px, opacity 0.95)，浪谷开阔素净 (0.8px, opacity 0.04)
                    const radius = 0.8 + waveFactor * 2.4;
                    const opacity = Math.max(0.04, waveFactor * 0.95);

                    ctx.beginPath();
                    ctx.arc(x, y, radius, 0, Math.PI * 2);
                    ctx.fillStyle = `rgba(${rBase}, ${gBase}, ${bBase}, ${opacity.toFixed(3)})`;
                    ctx.fill();
                }
            }

            ctx.restore();
            animId = requestAnimationFrame(render);
        };

        animId = requestAnimationFrame(render);

        return () => {
            isRunning = false;
            cancelAnimationFrame(animId);
        };
    }, [aspect]);

    return (
        <canvas
            ref={canvasRef}
            className={className || "h-full w-full"}
            style={{ width: "100%", height: "100%", display: "block" }}
        />
    );
}
