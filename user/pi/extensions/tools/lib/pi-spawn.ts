/**
 * shared pi process spawning for dedicated sub-agent tools.
 *
 * extracts the spawn-parse-collect loop from the generic subagent
 * extension into a reusable function. each dedicated tool (finder,
 * oracle, Task) calls piSpawn() with its own config.
 *
 * reimplements prompt interpolation ({cwd}, {roots}, {date}, etc.)
 * since tools/ can't import from sub-agents/ (separate nix store paths).
 */

import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";

// --- types ---

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface PiSpawnResult {
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface PiSpawnConfig {
	cwd: string;
	task: string;
	model?: string;
	builtinTools?: string[];
	extensionTools?: string[];
	systemPromptBody?: string;
	signal?: AbortSignal;
	onUpdate?: (result: PiSpawnResult) => void;
	sessionId?: string;
	repo?: string;
}

// --- interpolation (reimplemented; can't import sub-agents/) ---

function findGitRoot(dir: string): string {
	let current = path.resolve(dir);
	while (true) {
		try {
			const gitPath = path.join(current, ".git");
			const stat = fs.statSync(gitPath);
			if (stat.isDirectory() || stat.isFile()) return current;
		} catch { /* keep walking */ }
		const parent = path.dirname(current);
		if (parent === current) return dir;
		current = parent;
	}
}

function getGitRemoteUrl(dir: string): string {
	try {
		return execSync("git remote get-url origin", {
			cwd: dir, stdio: ["ignore", "pipe", "ignore"],
		}).toString().trim();
	} catch { return ""; }
}

function interpolatePromptVars(
	prompt: string, cwd: string, sessionId?: string, repo?: string,
): string {
	const roots = findGitRoot(cwd);
	const date = new Date().toLocaleDateString("en-US", {
		weekday: "short", year: "numeric", month: "short", day: "numeric",
	});
	const repoUrl = repo ?? getGitRemoteUrl(roots);
	let ls = "";
	try {
		ls = fs.readdirSync(roots).map((e) => {
			const full = path.join(roots, e);
			try { return fs.statSync(full).isDirectory() ? `${full}/` : full; } catch { return full; }
		}).join("\n");
	} catch { /* graceful */ }

	const vars: Record<string, string> = {
		cwd, roots, wsroot: roots, workingDir: cwd, date,
		os: `${os.platform()} (${os.release()}) on ${os.arch()}`,
		repo: repoUrl, sessionId: sessionId ?? "", ls,
	};

	const emptyKeys = Object.keys(vars).filter((k) => !vars[k]);
	const filled = Object.fromEntries(Object.entries(vars).filter(([, v]) => !!v));
	let result = prompt;

	if (emptyKeys.length > 0) {
		result = result.replace(new RegExp(`^.*\\{(${emptyKeys.join("|")})\\}.*\\n?`, "gm"), "");
	}
	const filledKeys = Object.keys(filled);
	if (filledKeys.length > 0) {
		result = result.replace(
			new RegExp(`\\{(${filledKeys.join("|")})\\}`, "g"),
			(_, key) => filled[key],
		);
	}
	return result;
}

// --- helpers ---

function writePromptToTempFile(label: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = label.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

export function zeroUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/**
 * read an agent prompt .md file, strip frontmatter, return body.
 * looks in ~/.pi/agent/agents/{filename}.
 */
export function readAgentPrompt(filename: string): string {
	const promptPath = path.join(os.homedir(), ".pi", "agent", "agents", filename);
	try {
		const content = fs.readFileSync(promptPath, "utf-8");
		if (content.startsWith("---")) {
			const endIdx = content.indexOf("\n---", 3);
			if (endIdx !== -1) return content.slice(endIdx + 4).trim();
		}
		return content;
	} catch { return ""; }
}

// --- spawn ---

export async function piSpawn(config: PiSpawnConfig): Promise<PiSpawnResult> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (config.model) args.push("--model", config.model);
	if (config.builtinTools && config.builtinTools.length > 0) {
		args.push("--tools", config.builtinTools.join(","));
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const result: PiSpawnResult = {
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: zeroUsage(),
	};

	try {
		if (config.systemPromptBody?.trim()) {
			const interpolated = interpolatePromptVars(
				config.systemPromptBody, config.cwd, config.sessionId, config.repo,
			);
			const tmp = writePromptToTempFile("subagent", interpolated);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${config.task}`);

		const spawnEnv: Record<string, string | undefined> = {
			...process.env, PI_READ_COMPACT: "1",
		};
		if (config.extensionTools) {
			spawnEnv.PI_INCLUDE_TOOLS = config.extensionTools.join(",");
		}

		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, {
				cwd: config.cwd, shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: spawnEnv,
			});

			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try { event = JSON.parse(line); } catch { return; }

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					result.messages.push(msg);

					if (msg.role === "assistant") {
						result.usage.turns++;
						const usage = (msg as any).usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
							result.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!result.model && (msg as any).model) result.model = (msg as any).model;
						if ((msg as any).stopReason) result.stopReason = (msg as any).stopReason;
						if ((msg as any).errorMessage) result.errorMessage = (msg as any).errorMessage;
					}

					if (config.onUpdate) config.onUpdate({ ...result });
				}

				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message as Message);
					if (config.onUpdate) config.onUpdate({ ...result });
				}
			};

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data: Buffer) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			if (config.signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (config.signal.aborted) killProc();
				else config.signal.addEventListener("abort", killProc, { once: true });
			}
		});

		result.exitCode = exitCode;
		if (wasAborted) {
			result.exitCode = 1;
			result.stopReason = "aborted";
		}
		return result;
	} finally {
		if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
		if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
	}
}
