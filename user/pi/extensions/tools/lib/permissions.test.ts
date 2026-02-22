import { describe, it, expect } from "bun:test";
import { evaluatePermission, type PermissionRule } from "./permissions";

const RULES: PermissionRule[] = [
	{
		tool: "Bash",
		matches: { cmd: ["*git add -A*", "*git add .*"] },
		action: "reject",
		message: "stage files explicitly with 'git add <file>' — unstaged changes may not be yours",
	},
	{
		tool: "Bash",
		matches: { cmd: ["*git push --force*", "*git push -f*", "*--force-with-lease*"] },
		action: "reject",
		message: "never force push. if diverged: 'git fetch origin && git rebase origin/main && git push'",
	},
	{
		tool: "Bash",
		matches: { cmd: ["rm *", "* && rm *", "* || rm *", "* ; rm *"] },
		action: "reject",
		message: "use 'trash <file>' instead of rm — recoverable deletion",
	},
	{ tool: "*", action: "allow" },
];

describe("evaluatePermission", () => {
	it("allows normal commands", () => {
		expect(evaluatePermission("Bash", { cmd: "git status" }, RULES)).toEqual({ action: "allow" });
		expect(evaluatePermission("Bash", { cmd: "ls -la" }, RULES)).toEqual({ action: "allow" });
		expect(evaluatePermission("Bash", { cmd: "nix build .#foo" }, RULES)).toEqual({ action: "allow" });
	});

	it("rejects git add -A", () => {
		const v = evaluatePermission("Bash", { cmd: "git add -A" }, RULES);
		expect(v.action).toBe("reject");
		expect(v.message).toContain("stage files explicitly");
	});

	it("rejects git add .", () => {
		const v = evaluatePermission("Bash", { cmd: "git add ." }, RULES);
		expect(v.action).toBe("reject");
	});

	it("allows explicit git add", () => {
		const v = evaluatePermission("Bash", { cmd: "git add src/foo.ts" }, RULES);
		expect(v.action).toBe("allow");
	});

	it("rejects force push variants", () => {
		expect(evaluatePermission("Bash", { cmd: "git push --force" }, RULES).action).toBe("reject");
		expect(evaluatePermission("Bash", { cmd: "git push -f origin main" }, RULES).action).toBe("reject");
		expect(evaluatePermission("Bash", { cmd: "git push --force-with-lease" }, RULES).action).toBe("reject");
	});

	it("allows normal git push", () => {
		expect(evaluatePermission("Bash", { cmd: "git push" }, RULES).action).toBe("allow");
		expect(evaluatePermission("Bash", { cmd: "git push origin main" }, RULES).action).toBe("allow");
	});

	it("rejects rm commands", () => {
		expect(evaluatePermission("Bash", { cmd: "rm foo.txt" }, RULES).action).toBe("reject");
		expect(evaluatePermission("Bash", { cmd: "rm -rf /tmp/junk" }, RULES).action).toBe("reject");
		expect(evaluatePermission("Bash", { cmd: "ls && rm foo" }, RULES).action).toBe("reject");
		expect(evaluatePermission("Bash", { cmd: "false || rm foo" }, RULES).action).toBe("reject");
		expect(evaluatePermission("Bash", { cmd: "echo hi ; rm foo" }, RULES).action).toBe("reject");
	});

	it("allows non-Bash tools via wildcard catch-all", () => {
		expect(evaluatePermission("Read", { cmd: "/etc/passwd" }, RULES)).toEqual({ action: "allow" });
	});

	it("allows everything when no rules", () => {
		expect(evaluatePermission("Bash", { cmd: "rm -rf /" }, [])).toEqual({ action: "allow" });
	});

	it("matches tool name with glob", () => {
		const rules: PermissionRule[] = [
			{ tool: "mcp__*", action: "reject", message: "no mcp" },
			{ tool: "*", action: "allow" },
		];
		expect(evaluatePermission("mcp__playwright_click", {}, rules).action).toBe("reject");
		expect(evaluatePermission("Bash", { cmd: "ls" }, rules).action).toBe("allow");
	});
});
