import { describe, expect, it } from "bun:test";
import React from "react";
import { formatStepLabel } from "../src/pages/chat/components/step-trail";

describe("formatStepLabel - 思考过程步骤文本智能 Chip 格式化", () => {
    it("自动将文件名（如 1000287761.jpg、SKILL.md）识别并包装为 Chip 节点", () => {
        const nodes = formatStepLabel("查看第一张图片，礼堂座位布局图 1000287761.jpg 以及 SKILL.md 文件");
        expect(nodes.length).toBeGreaterThan(1);
        // 查找包含 chip 的 React element
        const chips = nodes.filter((node) => React.isValidElement(node));
        expect(chips.length).toBe(2);
    });

    it("自动将带引号的短语或模型名/尺寸识别为 Chip", () => {
        const nodes = formatStepLabel('生成图片 · 主题 "77 (猫的名字) X KFC" 尺寸 1024x1024 模型 gpt-image-2.5');
        const chips = nodes.filter((node) => React.isValidElement(node));
        expect(chips.length).toBeGreaterThanOrEqual(3);
    });

    it("普通纯文本不产生多余 chip", () => {
        const nodes = formatStepLabel("理解用户需求并梳理生图意图");
        expect(nodes.length).toBe(1);
        expect(nodes[0]).toBe("理解用户需求并梳理生图意图");
    });
});
