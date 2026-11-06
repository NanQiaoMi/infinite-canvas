import { useEffect, useRef } from "react";

type ChatGptDotMatrixProps = {
    aspect?: number;
    className?: string;
};

/**
 * ChatGPT DALL-E 3 真实物理波浪点阵引擎（Waveform Dot Matrix）：
 * - 波点具备真正的物理空间位移（dy 纵向起伏波与 dx 轴向推移波），呈现如海浪/绸缎般起伏的生动波浪效果；
 * - 波峰粒子物理抬升、向外膨胀变大、呈现高饱和电光蓝（#2563eb / #38bdf8）；
 * - 波谷粒子物理下沉、收缩变小、呈现柔和半透明浅天蓝（rgba(147, 197, 253, 0.3)）；
 * - 背景保持纯净通透（绝无任何多余的浑浊彩斑杂色），纯正还原 ChatGPT 科技艺术美感。
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

            // 根据宽高比自适应行列数（密度均匀适中，完全符合截图视觉密度）
            const baseCount = 19;
            const cols = aspect >= 1 ? Math.round(baseCount * Math.min(1.4, Math.sqrt(aspect))) : Math.max(13, Math.round(baseCount * aspect));
            const rows = aspect <= 1 ? Math.round(baseCount / Math.min(1.4, Math.sqrt(aspect))) : Math.max(13, Math.round(baseCount / aspect));

            const padX = width * 0.07;
            const padY = height * 0.07;
            const stepX = (width - padX * 2) / (cols - 1);
            const stepY = (height - padY * 2) / (rows - 1);

            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const baseX = padX + c * stepX;
                    const baseY = padY + r * stepY;

                    const normCol = c / (cols - 1);
                    const normRow = r / (rows - 1);

                    // ===== 物理波浪流体动力学计算 =====
                    // 主前进波：自左上方朝右下方翻涌的宽幅波浪
                    const phaseMain = (normCol * 2.5 + normRow * 2.5) * Math.PI - time * 3.4;
                    // 次谐波：横向起伏调谐，产生水波自然涟漪
                    const phaseCross = (normCol * 1.8 - normRow * 1.5) * Math.PI + time * 1.6;

                    // 复合波高（-1.0 ~ +1.0）
                    const waveHeight = Math.sin(phaseMain) * 0.72 + Math.sin(phaseCross) * 0.28;

                    // 1. 物理位置空间位移（真正像波浪一样翻涌波动！）
                    // 纵向上下起伏（波浪振幅达 6.5px）
                    const dy = waveHeight * 6.5;
                    // 轴向微缩放推移（模拟流体纵波挤压效应）
                    const dx = Math.cos(phaseMain) * 2.2;

                    const drawX = baseX + dx;
                    const drawY = baseY + dy;

                    // 2. 波峰系数归一化（0.0 ~ 1.0），经指数锐化让波峰如浪尖般鲜明
                    const rawCrest = (waveHeight + 1) / 2;
                    const crest = Math.pow(Math.max(0, Math.min(1, rawCrest)), 1.9);

                    // 3. 四周留白边缘平滑衰减，防止碰到边界突兀
                    const edgeFade = Math.sin(normCol * Math.PI) * Math.sin(normRow * Math.PI);
                    const finalCrest = crest * Math.pow(edgeFade, 0.22);

                    // 4. 波点大小随波浪起伏剧烈呼吸：波谷收缩为 1.5px，浪尖膨胀至 3.6px
                    const radius = 1.5 + finalCrest * 2.1;

                    // 5. 纯正极简科技蓝调色板（无任何杂色）
                    ctx.beginPath();
                    ctx.arc(drawX, drawY, radius, 0, Math.PI * 2);

                    if (isDark) {
                        // 暗色模式：从微弱天蓝过渡到明亮电光青蓝
                        if (finalCrest > 0.6) {
                            ctx.fillStyle = `rgba(56, 189, 248, ${0.85 + finalCrest * 0.15})`; // sky-400
                        } else if (finalCrest > 0.25) {
                            ctx.fillStyle = `rgba(96, 165, 250, ${0.45 + finalCrest * 0.35})`; // blue-400
                        } else {
                            ctx.fillStyle = "rgba(56, 189, 248, 0.2)"; // 柔和暗天蓝基底
                        }
                    } else {
                        // 亮色模式：从浅淡透明冰蓝过渡到高饱和皇家宝蓝（#2563eb）
                        if (finalCrest > 0.6) {
                            ctx.fillStyle = `rgba(37, 99, 235, ${0.88 + finalCrest * 0.12})`; // 纯正电光蓝 #2563eb
                        } else if (finalCrest > 0.25) {
                            ctx.fillStyle = `rgba(59, 130, 246, ${0.5 + finalCrest * 0.35})`; // blue-500
                        } else {
                            ctx.fillStyle = "rgba(147, 197, 253, 0.32)"; // 浅冰蓝基底
                        }
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
