import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Box } from "@mariozechner/pi-tui";
import { extractMermaidBlocks, captureContextSlice, extractText } from "./extract";
import { createCache, pickBestPreset, hashCode } from "./render";
import type { RenderCache } from "./render";
import { openMermaidViewer } from "./viewer";

export type DiagramEntry = {
	id: string;
	block: { code: string; blockIndex: number; startLine: number; endLine: number };
	context: { beforeLines: string[]; afterLines: string[] };
	source: "assistant" | "user" | "command";
};

export default function mermaidInlineExtension(pi: ExtensionAPI) {
	const CUSTOM_TYPE = "mermaid-inline";
	const MAX_CODE_LENGTH = 20_000;
	const MAX_DIAGRAMS = 100;
	const cache: RenderCache = createCache();
	let diagrams: DiagramEntry[] = [];

	pi.registerMessageRenderer(CUSTOM_TYPE, (message, { expanded }, theme) => {
		const details = message.details as { diagramId: string } | undefined;
		const entry = details ? diagrams.find((d) => d.id === details.diagramId) : undefined;

		const component = {
			render(width: number): string[] {
				if (!entry) {
					return [theme.fg("dim", "diagram not found")];
				}

				try {
					const contentWidth = Math.max(width - 2, 10);
					const { preset, rendered, overflowed } = pickBestPreset(cache, entry.block.code, contentWidth);

					const lines: string[] = [];

					let label = theme.fg("customMessageLabel", theme.bold("mermaid"));
					if (overflowed) label += " " + theme.fg("dim", `[${preset.key}]`);
					lines.push(label);

					for (const line of rendered.lines) {
						lines.push(line);
					}

					if (overflowed) {
						lines.push(theme.fg("dim", "diagram wider than terminal — ctrl+shift+m to view full"));
					}

					return lines;
				} catch (err) {
					return [theme.fg("dim", `render error: ${err instanceof Error ? err.message : String(err)}`)];
				}
			},
			invalidate() {},
		};

		const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
		box.addChild(component);
		return box;
	});

	pi.on("message_end", async (event, ctx) => {
		const msg = event.message;
		if (msg.role !== "assistant") return;
		if ((msg as any).customType === CUSTOM_TYPE) return;

		const text = extractText(msg.content);
		if (!text) return;

		const blocks = extractMermaidBlocks(text);
		if (blocks.length === 0) return;

		for (const block of blocks) {
			if (block.code.length > MAX_CODE_LENGTH) continue;

			const context = captureContextSlice(text, block, 5);
			const id = `${Date.now()}:${block.blockIndex}:${hashCode(block.code)}`;
			const entry: DiagramEntry = { id, block, context, source: "assistant" };
			addDiagram(entry);

			pi.sendMessage({
				customType: CUSTOM_TYPE,
				content: "",
				display: true,
				details: { diagramId: id },
			});
		}
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return;
		const text = typeof event.text === "string" ? event.text : "";
		if (!text) return { action: "continue" as const };

		const blocks = extractMermaidBlocks(text);
		if (blocks.length === 0) return { action: "continue" as const };

		for (const block of blocks) {
			if (block.code.length > MAX_CODE_LENGTH) continue;

			const context = captureContextSlice(text, block, 5);
			const id = `${Date.now()}:${block.blockIndex}:${hashCode(block.code)}`;
			const entry: DiagramEntry = { id, block, context, source: "user" };
			addDiagram(entry);

			pi.sendMessage({
				customType: CUSTOM_TYPE,
				content: "",
				display: true,
				details: { diagramId: id },
			});
		}

		return { action: "continue" as const };
	});

	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((m: any) => m.customType !== CUSTOM_TYPE),
		};
	});

	pi.on("session_switch", async () => {
		diagrams = [];
	});

	pi.registerShortcut("ctrl+shift+m", {
		description: "View mermaid diagrams",
		handler: async (ctx) => {
			if (diagrams.length === 0) {
				lazyDiscoverDiagrams(ctx);
			}
			if (diagrams.length === 0) {
				if (ctx.hasUI) ctx.ui.notify("no mermaid diagrams in session", "info");
				return;
			}
			await openMermaidViewer({ ctx, diagrams, cache });
		},
	});

	pi.registerCommand("mermaid", {
		description: "Open mermaid diagram viewer",
		handler: async (_args, ctx) => {
			if (diagrams.length === 0) {
				lazyDiscoverDiagrams(ctx);
			}
			if (diagrams.length === 0) {
				if (ctx.hasUI) ctx.ui.notify("no mermaid diagrams in session", "info");
				return;
			}
			await openMermaidViewer({ ctx, diagrams, cache });
		},
	});

	function addDiagram(entry: DiagramEntry) {
		diagrams.push(entry);
		if (diagrams.length > MAX_DIAGRAMS) {
			diagrams = diagrams.slice(-MAX_DIAGRAMS);
		}
	}

	/** scan session history for mermaid blocks we missed (e.g. session loaded from disk) */
	function lazyDiscoverDiagrams(ctx: ExtensionContext) {
		const entries = ctx.sessionManager.getBranch();
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "assistant") continue;

			const text = extractText(entry.message.content);
			if (!text) continue;

			const blocks = extractMermaidBlocks(text);
			for (const block of blocks) {
				if (block.code.length > MAX_CODE_LENGTH) continue;

				const hash = hashCode(block.code);
				if (diagrams.some((d) => d.id.endsWith(hash))) continue;

				const context = captureContextSlice(text, block, 5);
				const id = `${entry.id}:${block.blockIndex}:${hash}`;
				addDiagram({ id, block, context, source: "assistant" });
			}
		}
	}
}
