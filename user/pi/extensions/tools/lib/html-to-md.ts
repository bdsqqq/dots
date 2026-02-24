/**
 * cheerio-based HTML→markdown. returns null when cheerio isn't
 * resolvable (caller falls back to raw output). optimizes for
 * LLM-readable output over pixel-perfect fidelity.
 *
 * uses createRequire(__filename) so node resolves cheerio from
 * user/pi/node_modules/ — jiti's intercepted require resolves
 * from the loader's path instead of the extension file's path.
 */

import { createRequire } from "node:module";

let cheerioLoad: ((html: string) => any) | null = null;

try {
	const localRequire = createRequire(__filename);
	const cheerio = localRequire("cheerio");
	cheerioLoad = cheerio.load;
} catch {}

const REMOVE_SELECTORS = [
	"script", "style", "noscript", "svg", "iframe",
	"nav", "footer", "header", "aside",
	'[role="navigation"]', '[role="banner"]',
	'[role="complementary"]', '[role="contentinfo"]',
	".cookie-banner", ".cookie-consent",
	"#cookie-banner", "#cookie-consent",
].join(", ");

const MAIN_SELECTORS = [
	"main", "article", '[role="main"]',
	"#content", "#main", ".content", ".main",
	".post-content", ".article-content", ".entry-content",
];

function isHtmlContent(text: string): boolean {
	const trimmed = text.trimStart().slice(0, 200).toLowerCase();
	return trimmed.startsWith("<!doctype") || trimmed.startsWith("<html") || trimmed.startsWith("<?xml");
}

function nodeToMd($: any, node: any): string {
	if (node.type === "text") {
		return (node.data || "").replace(/[ \t]+/g, " ");
	}
	if (node.type !== "tag") return "";

	const tag = node.name?.toLowerCase();
	if (!tag) return "";

	const el = $(node);
	const children = el.contents().toArray();
	const inner = () => children.map((c: any) => nodeToMd($, c)).join("");

	if (/^h[1-6]$/.test(tag)) {
		const level = parseInt(tag[1]);
		const text = inner().trim();
		if (!text) return "";
		return `\n\n${"#".repeat(level)} ${text}\n\n`;
	}

	if (tag === "p") {
		const text = inner().trim();
		return text ? `\n\n${text}\n\n` : "";
	}
	if (tag === "br") return "\n";

	if (tag === "a") {
		const href = el.attr("href");
		const text = inner().trim();
		if (!text) return "";
		if (!href || href.startsWith("#") || href.startsWith("javascript:")) return text;
		return `[${text}](${href})`;
	}

	if (tag === "strong" || tag === "b") {
		const text = inner().trim();
		return text ? `**${text}**` : "";
	}
	if (tag === "em" || tag === "i") {
		const text = inner().trim();
		return text ? `*${text}*` : "";
	}

	if (tag === "code") {
		if (el.parent().is("pre")) return el.text();
		const text = el.text().trim();
		return text ? `\`${text}\`` : "";
	}
	if (tag === "pre") {
		const code = el.find("code");
		const lang = code.attr("class")?.match(/language-(\w+)/)?.[1] || "";
		const text = code.length > 0 ? code.text() : el.text();
		return `\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
	}

	if (tag === "ul" || tag === "ol") {
		const items = el.children("li").toArray();
		const lines = items.map((li: any, i: number) => {
			const text = nodeToMd($, li).trim();
			const prefix = tag === "ol" ? `${i + 1}. ` : "- ";
			return `${prefix}${text}`;
		});
		return `\n\n${lines.join("\n")}\n\n`;
	}
	if (tag === "li") return inner();

	if (tag === "blockquote") {
		const text = inner().trim();
		return text ? `\n\n${text.split("\n").map((l: string) => `> ${l}`).join("\n")}\n\n` : "";
	}

	if (tag === "img") {
		const alt = el.attr("alt") || "";
		const src = el.attr("src") || "";
		if (!src) return "";
		return `![${alt}](${src})`;
	}

	if (tag === "table") {
		const rows = el.find("tr").toArray();
		if (rows.length === 0) return "";
		const result: string[] = [];
		for (let i = 0; i < rows.length; i++) {
			const cells = $(rows[i]).find("th, td").toArray().map((c: any) => $(c).text().trim());
			if (cells.length === 0) continue;
			result.push(`| ${cells.join(" | ")} |`);
			if (i === 0) {
				result.push(`| ${cells.map(() => "---").join(" | ")} |`);
			}
		}
		return result.length > 0 ? `\n\n${result.join("\n")}\n\n` : "";
	}

	if (["div", "section", "article", "main", "figure", "figcaption", "details", "summary", "dl", "dt", "dd"].includes(tag)) {
		return inner();
	}

	if (tag === "hr") return "\n\n---\n\n";

	return inner();
}

function collapseWhitespace(text: string): string {
	return text
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]+\n/g, "\n")
		.trim();
}

export function htmlToMarkdown(html: string): string | null {
	if (!cheerioLoad) return null;
	if (!isHtmlContent(html)) return null;

	const $ = cheerioLoad(html);
	$(REMOVE_SELECTORS).remove();

	// find main content area
	let root = null;
	for (const sel of MAIN_SELECTORS) {
		const found = $(sel);
		if (found.length > 0) {
			root = found.first();
			break;
		}
	}
	if (!root) root = $("body");

	const md = root.contents().toArray().map((n: any) => nodeToMd($, n)).join("");
	return collapseWhitespace(md);
}

export { isHtmlContent as isHtml };
