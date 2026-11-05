let testNow: number | null = null;

/** 允许测试固定时钟；生产环境始终使用 Date.now()。 */
export function setNowForTests(value: number | null) {
    testNow = value;
}

export function nowMs(): number {
    return testNow ?? Date.now();
}
