/**
 * 生图/改图工具的重试策略：只对「网络抖动、上游 5xx、超时、任务中断」这类可恢复错误重试一次，
 * 参数错误、额度不足、缺少参考图等确定性失败直接返回。
 */
const RETRYABLE_GENERATION_ERROR_PATTERN =
    /(?:network error|failed to fetch|load failed|econnreset|econnrefused|etimedout|socket hang up|fetch failed|networkerror|unable to connect|不可达|connection refused|timeout|timed out|超时|网络|502|503|504|429|task_interrupted|deadline exceeded|queue[_ ]?timeout|server error|internal error|请求过于频繁|稍后再试|限流|rate.?limit|too many requests)/i;

export const MAX_GENERATION_ATTEMPTS = 2;

export function isRetryableGenerationError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return RETRYABLE_GENERATION_ERROR_PATTERN.test(message);
}

/** 执行一次可恢复失败自动重试的生成任务；被取消或确定性失败时不重试。 */
export async function runWithGenerationRetry<T>(
    run: () => Promise<T>,
    signal: AbortSignal,
    retryDelayMs = 800,
): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await run();
        } catch (error) {
            if (signal.aborted || attempt >= MAX_GENERATION_ATTEMPTS - 1 || !isRetryableGenerationError(error)) throw error;
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
        }
    }
}

/** 可恢复失败后选择同能力的另一个图片模型做一次降级尝试；GIF 只能降级到 gpt-image-2.6 系列。 */
export function pickFallbackImageModel(options: string[], current: string, isGif: boolean): string | null {
    const candidates = options.filter((option) => option !== current && (!isGif || /gpt-image-2\.6/i.test(option)));
    return candidates[0] ?? null;
}
