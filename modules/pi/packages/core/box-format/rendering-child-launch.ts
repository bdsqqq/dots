// Launch the installed Pi CLI, not a replacement RPC/JSON implementation.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const args = [];
const input = process.argv.slice(2);
for (let i = 0; i < input.length; i++) {
  const argument = input[i]!;
  if (
    [
      "--model",
      "--tools",
      "--exclude-tools",
      "--append-system-prompt",
    ].includes(argument)
  ) {
    i++;
    continue;
  }
  args.push(argument);
}
args.push(
  "--offline",
  "--no-extensions",
  "--no-mcp",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--no-themes",
  "--system-prompt",
  "Run the requested fixture read and return its result.",
  "--tools",
  "read",
  "--provider",
  "rendering-child",
  "--model",
  "deterministic",
  "-e",
  join(root, "packages/extensions/read/index.ts"),
  "-e",
  join(root, "packages/core/box-format/rendering-child-fixture.ts"),
);
const proc = spawn(join(root, "node_modules/.bin/pi"), args, {
  stdio: "inherit",
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: join(
      process.env.PI_CODING_AGENT_DIR!,
      "rendering-child",
    ),
  },
});
const timer = setTimeout(() => {
  proc.kill("SIGKILL");
  process.exit(124);
}, 20000);
proc.on("exit", (code) => {
  clearTimeout(timer);
  process.exit(code ?? 1);
});
