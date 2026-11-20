import i18n from "@/i18n";
import { randomId } from "@/lib/utils";

/** 读取 Agent 运行时文案。 */
export const rt = (key: string, options?: Record<string, unknown>) => i18n.t(`agent.runtime.${key}`, options);

export function createId() {
    return randomId();
}

export function readDataUrl(file: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error(rt("imageReadFailed")));
        reader.readAsDataURL(file);
    });
}
