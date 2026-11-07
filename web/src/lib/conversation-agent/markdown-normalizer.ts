/**
 * 规范化聊天输出中的 Markdown 文本：
 * 1. 保护真实围栏代码块（``` ... ``` 或 ~~~ ... ~~~）不被改动；
 * 2. 移除围栏代码块之外偶发的行首 4 空格/Tab 缩进，防止 CommonMark 将普通加粗/示例段落误识别为缩进代码块（Indented Code Block）并渲染为灰色代码框；
 * 3. 修复粗体标记内侧的意外空白（如 `** 示例 **`、`** 示例**`、`**示例 **` -> `**示例**`），确保 CommonMark 正确识别 <strong> 粗体；
 * 4. 容忍流式生成中未闭合的代码块。
 */
export function normalizeMarkdownForChat(markdown: string): string {
    if (!markdown) return "";

    // 将文本拆分为【真实围栏代码块】和【普通 Markdown 文本段落】
    const parts: string[] = [];
    const fenceRegex = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = fenceRegex.exec(markdown)) !== null) {
        if (match.index > lastIndex) {
            parts.push(cleanChatMarkdownSegment(markdown.slice(lastIndex, match.index)));
        }
        // 围栏代码块完整保留
        parts.push(match[0]);
        lastIndex = fenceRegex.lastIndex;
    }
    if (lastIndex < markdown.length) {
        parts.push(cleanChatMarkdownSegment(markdown.slice(lastIndex)));
    }

    return parts.join("");
}

function cleanChatMarkdownSegment(text: string): string {
    // 1. 修复成对粗体标记内侧的空格：
    // 使用 [^\*\n]+? 确保单次匹配绝不跨越其他星号，消除交错配对风险；
    // 将两端空格收拢到 ** 内部去除，使 CommonMark 能够将其识别为强调语法。
    let cleaned = text.replace(/\*\*([^\*\n]+?)\*\*/g, (full, inner: string) => {
        const trimmed = inner.trim();
        if (!trimmed) return full;
        return `**${trimmed}**`;
    });

    // 2. 消除误触发 Indented Code Block 的行首 4 空格或 Tab 缩进
    const lines = cleaned.split("\n");
    const normalizedLines = lines.map((line) => {
        const indentMatch = line.match(/^([ \t]{4,}|\t+)(.*)$/);
        if (indentMatch) {
            const rest = indentMatch[2];
            // 如果剩余内容是列表项（- , * , + , 1. ），将其规范化为 2 空格子列表缩进，避免触发 4 空格代码块阈值
            if (/^[-*+]\s|^\d+\.\s/.test(rest.trimStart())) {
                return `  ${rest.trimStart()}`;
            }
            // 普通段落文本（如 `    **生成一张...**`），直接消除行首多余缩进
            return rest;
        }
        return line;
    });

    return normalizedLines.join("\n");
}
