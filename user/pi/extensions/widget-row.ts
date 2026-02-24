import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export * from "./lib/widget-row";

// noop extension to satisfy loader when this file is present in ~/.pi/agent/extensions
export default function (_pi: ExtensionAPI): void {}
