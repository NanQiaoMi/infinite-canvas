import { useEffect, useRef } from "react";

type ChatGptDotMatrixProps = {
    aspect?: number;
    className?: string;
};

/**
 * ChatGPT DALL-E 3 标志性点阵动画（Dot Matrix Canvas）：
 * - 在画布上生成规则点阵网格（根据宽高比自适应行数与列数）；
 * - 纯净微粒子点阵沿对角线以平滑正弦驻波律动起伏（双向波动叠加）；
 * - 波峰粒子膨胀变亮（纯净高饱和蓝），波谷粒子收缩变淡（半透明天蓝）；
 * - 针对 Retina 屏幕适配 devicePixelRatio，完全还原 ChatGPT 官方生图动画质感。
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

            // 根据长宽比计算行列数
            const baseCount = 18;
            const cols = aspect >= 1 ? Math.round(baseCount * Math.min(1.4, Math.sqrt(aspect))) : Math.max(12, Math.round(baseCount * aspect));
            const rows = aspect <= 1 ? Math.round(baseCount / Math.min(1.4, Math.sqrt(aspect))) : Math.max(12, Math.round(baseCount / aspect));

            const padX = width * 0.08;
            const padY = height * 0.08;
            const stepX = (width - padX * 2) / (cols - 1);
            const stepY = (height - padY * 2) / (rows - 1);

            // 纯净蓝色调（ChatGPT 官方蓝调色板）
            const activeColor = isDark ? "rgb(56, 189, 248)" : "rgb(37, 99, 235)"; // sky-400 / blue-600
            const midColor = isDark ? "rgba(96, 165, 250, 0.65)" : "rgba(59, 130, 246, 0.6)"; // blue-400 / blue-500
            const faintColor = isDark ? "rgba(56, 189, 248, 0.16)" : "rgba(147, 197, 253, 0.28)"; // sky-400 / blue-200

            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const x = padX + c * stepX;
                    const y = padY + r * stepY;

                    // 双正弦波叠加营造 ChatGPT 的对角平滑波浪
                    const normCol = c / (cols - 1);
                    const normRow = r / (rows - 1);

                    // 主波（左上向右下扩散）
                    const wave1 = Math.sin((normCol * 2.8 + normRow * 2.8) * Math.PI - time * 3.4);
                    // 辅助波（局部微扰动）
                    const wave2 = Math.cos((normCol * 2.0 - normRow * 1.6) * Math.PI + time * 1.8);

                    const rawVal = (wave1 * 0.65 + wave2 * 0.35 + 1) / 2; // 0 ~ 1
                    const intensity = Math.pow(Math.max(0, Math.min(1, rawVal)), 2.2); // 锐化波峰

                    // 边缘衰减，让点阵边缘柔和隐入留白
                    const edgeFade = Math.sin(normCol * Math.PI) * Math.sin(normRow * Math.PI);
                    const finalIntensity = intensity * Math.pow(edgeFade, 0.25);

                    // 动态半径与透明度
                    const radius = 1.6 + finalIntensity * 1.8; // 1.6px ~ 3.4px

                    ctx.beginPath();
                    ctx.arc(x, y, radius, 0, Math.PI * 2);

                    if (finalIntensity > 0.55) {
                        ctx.fillStyle = activeColor;
                    } else if (finalIntensity > 0.25) {
                        ctx.fillStyle = midColor;
                    } else {
                        ctx.fillStyle = faintColor;
                    }

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
