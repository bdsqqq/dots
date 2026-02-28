export type MermaidBlock = {
	code: string;
	blockIndex: number;
	startLine: number;
	endLine: number;
};

export type MermaidContextSlice = {
	beforeLines: string[];
	afterLines: string[];
};

const OPENING_FENCE = /^\s*`{3,}\s*mermaid\b/i;
const CLOSING_FENCE = /^\s*`{3,}\s*$/;

/**
 * line-based scan for mermaid fenced blocks.
 * avoids global regex because agent output often has nested or malformed fences.
 */
export function extractMermaidBlocks(text: string, maxBlocks = 10): MermaidBlock[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const blocks: MermaidBlock[] = [];
	let i = 0;

	while (i < lines.length && blocks.length < maxBlocks) {
		if (OPENING_FENCE.test(lines[i])) {
			const startLine = i;
			i++;
			const codeLines: string[] = [];

			while (i < lines.length && !CLOSING_FENCE.test(lines[i])) {
				codeLines.push(lines[i]);
				i++;
			}

			const endLine = i; // closing fence line (or EOF if unclosed)
			const code = codeLines.join("\n").trimEnd();

			if (code.length > 0) {
				blocks.push({ code, blockIndex: blocks.length, startLine, endLine });
			}
		}
		i++;
	}

	return blocks;
}

/** grab surrounding context lines, stripping trailing blanks */
export function captureContextSlice(
	text: string,
	block: MermaidBlock,
	radius = 5,
): MermaidContextSlice {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");

	const beforeLines = lines.slice(Math.max(0, block.startLine - radius), block.startLine);
	const afterLines = lines.slice(block.endLine + 1, Math.min(lines.length, block.endLine + 1 + radius));

	stripTrailingEmpty(beforeLines);
	stripTrailingEmpty(afterLines);

	return { beforeLines, afterLines };
}

/**
 * handle pi's message content format — string or ContentPart[].
 * ContentPart arrays contain objects with a `text` field for text parts.
 */
export function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((p): p is { text: string } => typeof p === "object" && p !== null && "text" in p && typeof p.text === "string")
			.map((p) => p.text)
			.join("\n");
	}
	return "";
}

function stripTrailingEmpty(arr: string[]): void {
	while (arr.length > 0 && arr[arr.length - 1].trim() === "") {
		arr.pop();
	}
}
