import { describe, expect, it } from "bun:test";

import { computeContactSheetLayout, computeSampleTimestamps, fitMaxEdge, normalizeFocusTimestamps } from "../src/lib/canvas/canvas-video-frame";

describe("video contact sheet and frame utilities", () => {
    it("samples evenly spaced timestamps clamped to 3-9 frames", () => {
        expect(computeSampleTimestamps(6, 6)).toEqual([0, 1.19, 2.38, 3.57, 4.76, 5.95]);
        expect(computeSampleTimestamps(10, 2)).toHaveLength(3);
        expect(computeSampleTimestamps(10, 20)).toHaveLength(9);
        expect(computeSampleTimestamps(0, 6)).toEqual([0, 0, 0, 0, 0, 0]);
    });

    it("fits dimensions within maxEdge preserving aspect ratio", () => {
        expect(fitMaxEdge(2560, 1440, 1280)).toEqual({ width: 1280, height: 720 });
        expect(fitMaxEdge(720, 1280, 1280)).toEqual({ width: 720, height: 1280 });
        expect(fitMaxEdge(1080, 1920, 1280)).toEqual({ width: 720, height: 1280 });
    });

    it("computes grid layouts keeping total canvas within maxEdge", () => {
        const sixLandscape = computeContactSheetLayout(6, 16 / 9, 1280);
        expect(sixLandscape.cols).toBe(3);
        expect(sixLandscape.rows).toBe(2);
        expect(Math.max(sixLandscape.canvasWidth, sixLandscape.canvasHeight)).toBeLessThanOrEqual(1280);

        const tenPortrait = computeContactSheetLayout(10, 9 / 16, 1280);
        expect(tenPortrait.cols).toBe(4);
        expect(tenPortrait.rows).toBe(3);
        expect(Math.max(tenPortrait.canvasWidth, tenPortrait.canvasHeight)).toBeLessThanOrEqual(1280);
    });

    it("normalizes focusTimestamps by filtering invalid entries, clamping to duration, deduplicating, and capping at 4", () => {
        expect(normalizeFocusTimestamps([-1, "bad", 0, 2.345, 2.349, 10, 99, 1.5, 3.2], 6)).toEqual([0, 2.35, 5.95, 1.5]);
        expect(normalizeFocusTimestamps("not-an-array", 6)).toEqual([]);
        expect(normalizeFocusTimestamps([1, 2], 0)).toEqual([0]);
    });
});
