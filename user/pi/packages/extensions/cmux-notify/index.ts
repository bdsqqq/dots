import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";

export default function cmuxNotifyExtension(pi: ExtensionAPI): void {
  pi.on("agent_settled", () => {
    if (!process.env.CMUX_WORKSPACE_ID || !process.env.CMUX_SURFACE_ID) return;

    execFile(
      "cmux",
      [
        "notify",
        "--title",
        "pi",
        "--subtitle",
        "Waiting",
        "--body",
        "Agent needs input",
      ],
      () => {},
    );
  });
}
