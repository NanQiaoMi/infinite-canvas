import { nowMs } from "./clock";

type Fields = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", message: string, fields?: Fields) {
    const line = JSON.stringify({ time: new Date(nowMs()).toISOString(), level, message, ...fields });
    if (level === "error") console.error(line);
    else console.log(line);
}

export const log = {
    info: (message: string, fields?: Fields) => emit("info", message, fields),
    warn: (message: string, fields?: Fields) => emit("warn", message, fields),
    error: (message: string, fields?: Fields) => emit("error", message, fields),
};
