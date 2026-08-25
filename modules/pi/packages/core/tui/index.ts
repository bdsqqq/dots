/**
 * lazy re-exports of @earendil-works/pi-tui components.
 *
 * pi-tui is provided by pi's runtime and isn't resolvable in
 * standalone test environments. lazy-loading via
 * require() defers resolution to first use — which only happens
 * inside renderCall/renderResult at runtime, never during
 * execute()-only tests.
 *
 * usage: import { getText, getContainer } from "@bds_pi/tui";
 *        return getText()("hello", 0, 0);
 */

let _piTui: any;
function tui() {
  if (!_piTui) {
    _piTui = require("@earendil-works/pi-tui");
  }
  return _piTui;
}

/** lazy Text constructor — call getText() to get the Text class, then instantiate */
export function getText(): new (
  text: string,
  paddingX: number,
  paddingY: number,
) => any {
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

/** lazy ANSI-aware single-line truncation */
export function getTruncateToWidth(): (
  text: string,
  maxWidth: number,
  ellipsis?: string,
) => string {
  return tui().truncateToWidth;
}
