import type { ServerCapability } from "@/types/server";

export const ADMIN_CAPABILITIES: ServerCapability[] = ["image", "video", "text", "audio"];

export function capabilityLabelKey(capability: ServerCapability) {
    return `server.capabilities.${capability}`;
}

export function formatAdminTime(value: number | string | null | undefined, locale: string): string {
    if (value === null || value === undefined || value === "") return "-";
    const date = typeof value === "number" ? new Date(value) : new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    return date.toLocaleString(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function formatUptime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "-";
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}
