/**
 * lazy re-exports of @mariozechner/pi-tui components.
 *
 * pi-tui is provided by pi's runtime and isn't resolvable in
 * standalone test environments (bun test). lazy-loading via
 * require() defers resolution to first use — which only happens
 * inside renderCall/renderResult at runtime, never during
 * execute()-only tests.
 *
 * usage: import { getText, getContainer } from "./lib/tui";
 *        return getText()("hello", 0, 0);
 */

let _piTui: any;
function tui() {
	if (!_piTui) {
		_piTui = require("@mariozechner/pi-tui");
	}
	return _piTui;
}

/** lazy Text constructor — call getText() to get the Text class, then instantiate */
export function getText(): new (text: string, paddingX: number, paddingY: number) => any {
	return tui().Text;
}

/** lazy Container constructor */
export function getContainer(): new (...args: any[]) => any {
	return tui().Container;
}

/** lazy Markdown constructor */
export function getMarkdown(): new (...args: any[]) => any {
	return tui().Markdown;
}
