/**
 * image-attachments — clipboard image staging with preview overlays.
 *
 * Features:
 * - Ctrl+V: paste image from clipboard into a staged attachment list
 * - widget above editor: left-aligned attachment pills
 * - Alt+1..9: open image preview for the indexed attachment
 * - Alt+I: open attachment picker overlay, then preview selection
 * - on send: transforms input into text + image content parts
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Image,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { createRequire } from "node:module";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface TrackedImage {
	filePath: string;
	mimeType: string;
	base64: string;
	sizeKB: number;
	label: string;
}

type ClipboardModule = {
	hasImage: () => boolean;
	getImageBinary: () => Promise<number[]>;
};

const cjsRequire = createRequire(import.meta.url);
let clipboardModule: ClipboardModule | null = null;
try {
	clipboardModule = cjsRequire("@mariozechner/clipboard") as ClipboardModule;
} catch {
	clipboardModule = null;
}

function buildPillLine(images: TrackedImage[], theme: Theme, width: number): string {
	const prefix = theme.fg("dim", "attachments: ");
	const pills = images.map((img, idx) => {
		const hotkey = idx < 9 ? `alt+${idx + 1}` : "";
		const suffix = hotkey ? theme.fg("muted", `(${hotkey})`) : "";
		return theme.fg("accent", `[${img.label}]`) + suffix;
	});
	const line = prefix + pills.join("  ");
	return truncateToWidth(line, width);
}

async function showImageOverlay(ctx: ExtensionContext, image: TrackedImage): Promise<void> {
	await ctx.ui.custom<void>(
		(_tui, theme, _kb, done) => {
			const imageComp = new Image(
				image.base64,
				image.mimeType,
				{ fallbackColor: (s: string) => theme.fg("dim", s) },
				{ maxWidthCells: 62 },
			);

			const renderRow = (content: string, innerW: number) =>
				theme.fg("border", "│") +
				content +
				" ".repeat(Math.max(0, innerW - visibleWidth(content))) +
				theme.fg("border", "│");

			const ext = image.mimeType.split("/")[1]?.toUpperCase() ?? "IMG";
			const meta = `${ext} • ${image.sizeKB} KB`;

			return {
				render(width: number): string[] {
					const boxW = Math.min(width, 78);
					const innerW = boxW - 2;
					const bar = "─".repeat(innerW);
					const lines: string[] = [];
					lines.push(theme.fg("border", `╭${bar}╮`));
					lines.push(renderRow(` ${theme.bold(image.label)}  ${theme.fg("dim", meta)}`, innerW));
					lines.push(renderRow("", innerW));
					for (const line of imageComp.render(innerW)) {
						lines.push(renderRow(line, innerW));
					}
					lines.push(renderRow("", innerW));
					lines.push(theme.fg("border", `├${bar}┤`));
					lines.push(renderRow(theme.fg("dim", " esc close"), innerW));
					lines.push(theme.fg("border", `╰${bar}╯`));
					return lines;
				},
				handleInput(data: string): void {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
						done();
					}
				},
				invalidate(): void {
					imageComp.invalidate();
				},
			} satisfies Component;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "top-center",
				width: 78,
				minWidth: 42,
				maxHeight: "80%",
				offsetY: 1,
			},
		},
	);
}

async function showAttachmentPicker(ctx: ExtensionContext, images: TrackedImage[]): Promise<number | null> {
	if (images.length === 0) return null;

	return await ctx.ui.custom<number | null>(
		(tui, theme, _kb, done) => {
			let selected = 0;

			const renderRow = (content: string, innerW: number) =>
				theme.fg("border", "│") +
				content +
				" ".repeat(Math.max(0, innerW - visibleWidth(content))) +
				theme.fg("border", "│");

			return {
				render(width: number): string[] {
					const boxW = Math.min(width, 64);
					const innerW = boxW - 2;
					const bar = "─".repeat(innerW);
					const lines: string[] = [];
					lines.push(theme.fg("border", `╭${bar}╮`));
					lines.push(renderRow(theme.fg("dim", " select attachment to preview"), innerW));
					lines.push(theme.fg("border", `├${bar}┤`));

					for (let i = 0; i < images.length; i++) {
						const isSelected = i === selected;
						const pointer = isSelected ? theme.fg("accent", "❯ ") : "  ";
						const label = `${images[i].label} ${theme.fg("dim", `${images[i].sizeKB} KB`)}`;
						const text = isSelected ? theme.fg("accent", theme.bold(label)) : label;
						lines.push(renderRow(pointer + text, innerW));
					}

					lines.push(theme.fg("border", `├${bar}┤`));
					lines.push(renderRow(theme.fg("dim", " ↑↓ choose • enter preview • esc close"), innerW));
					lines.push(theme.fg("border", `╰${bar}╯`));
					return lines;
				},
				handleInput(data: string): void {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
						done(null);
						return;
					}
					if (matchesKey(data, Key.up)) {
						selected = Math.max(0, selected - 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.down)) {
						selected = Math.min(images.length - 1, selected + 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.enter)) {
						done(selected);
					}
				},
				invalidate(): void {},
			} satisfies Component;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "top-center",
				width: 64,
				minWidth: 40,
				maxHeight: "65%",
				offsetY: 1,
			},
		},
	);
}

export default function (pi: ExtensionAPI) {
	let attachments: TrackedImage[] = [];

	const syncWidget = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		if (attachments.length === 0) {
			ctx.ui.setWidget("image-attachments", undefined);
			return;
		}

		ctx.ui.setWidget(
			"image-attachments",
			(_tui, theme) => ({
				render: (width: number) => [buildPillLine(attachments, theme, width)],
				invalidate(): void {},
			}),
			{ placement: "aboveEditor" },
		);
	};

	const previewIndex = async (ctx: ExtensionContext, idx: number): Promise<void> => {
		const image = attachments[idx];
		if (!image) return;
		await showImageOverlay(ctx, image);
	};

	pi.registerShortcut("ctrl+v", {
		description: "paste image from clipboard",
		handler: async (ctx) => {
			if (!clipboardModule || !clipboardModule.hasImage()) return;
			try {
				const data = await clipboardModule.getImageBinary();
				if (!data || data.length === 0) return;
				const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
				const mimeType = "image/png";
				const base64 = Buffer.from(bytes).toString("base64");

				const fileName = `pi-clipboard-${crypto.randomUUID()}.png`;
				const filePath = path.join(os.tmpdir(), fileName);
				fs.writeFileSync(filePath, Buffer.from(bytes));

				const sizeKB = Math.max(1, Math.round(bytes.length / 1024));
				attachments.push({
					filePath,
					mimeType,
					base64,
					sizeKB,
					label: `image ${attachments.length + 1}`,
				});

				syncWidget(ctx);
				ctx.ui.notify(`attached ${attachments[attachments.length - 1].label}`, "info");
			} catch (error) {
				ctx.ui.notify(`clipboard paste failed: ${error}`, "error");
			}
		},
	});

	for (let i = 1; i <= 9; i++) {
		pi.registerShortcut(`alt+${i}`, {
			description: `preview attachment ${i}`,
			handler: async (ctx) => {
				await previewIndex(ctx, i - 1);
			},
		});
	}

	pi.registerShortcut("alt+i", {
		description: "open attachment picker",
		handler: async (ctx) => {
			const idx = await showAttachmentPicker(ctx, attachments);
			if (idx == null) return;
			await previewIndex(ctx, idx);
		},
	});

	pi.on("input", async (event, ctx) => {
		if (attachments.length === 0) return { action: "continue" as const };

		const images = attachments.map((img) => ({
			type: "image" as const,
			mimeType: img.mimeType,
			data: img.base64,
		}));

		attachments = [];
		syncWidget(ctx);

		return {
			action: "transform" as const,
			text: event.text,
			images,
		};
	});

	pi.on("session_switch", async (_event, ctx) => {
		attachments = [];
		syncWidget(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		attachments = [];
		syncWidget(ctx);
	});
}
