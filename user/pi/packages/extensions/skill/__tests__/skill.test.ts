/**
 * SDK-backed integration tests for skill extension.
 *
 * Uses real tmpdir for file system tests, minimal mocks for pi API.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import skillExtension, {
  createSkillTool,
  getAgentDir,
  getSkillPathsFromSettings,
  findSkill,
  listAvailableSkills,
  collectSkillFiles,
} from "../index";

/**
 * minimal extension api harness for load-time extension tests.
 */
function createMockExtensionApiHarness() {
  const tools: unknown[] = [];
  const pi = {
    registerTool(tool: unknown) {
      tools.push(tool);
    },
  } as any;
  return { pi, tools };
}

describe("skill extension", () => {
  describe("extension registration", () => {
    it("registers the skill tool on load", () => {
      const harness = createMockExtensionApiHarness();
      skillExtension(harness.pi);
      expect(harness.tools).toHaveLength(1);
      expect((harness.tools[0] as any).name).toBe("skill");
    });
  });

  describe("createSkillTool", () => {
    it("creates tool with correct metadata", () => {
      const tool = createSkillTool();
      expect(tool.name).toBe("skill");
      expect(tool.label).toBe("Load Skill");
      expect(tool.description).toContain("domain-specific instructions");
      expect(tool.parameters).toBeDefined();
    });
  });
});

describe("skill discovery (real tmpdir)", () => {
  let tmpDir: string;
  let skillDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-test-"));
    skillDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillDir, { recursive: true });
    originalEnv = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv !== undefined) {
      process.env.PI_CODING_AGENT_DIR = originalEnv;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });

  describe("getAgentDir", () => {
    it("returns default ~/.pi/agent without env", () => {
      delete process.env.PI_CODING_AGENT_DIR;
      const result = getAgentDir();
      expect(result).toBe(path.join(os.homedir(), ".pi", "agent"));
    });

    it("respects PI_CODING_AGENT_DIR env var", () => {
      process.env.PI_CODING_AGENT_DIR = "/custom/path";
      expect(getAgentDir()).toBe("/custom/path");
    });

    it("expands ~ in PI_CODING_AGENT_DIR", () => {
      process.env.PI_CODING_AGENT_DIR = "~/custom";
      expect(getAgentDir()).toBe(path.join(os.homedir(), "custom"));
    });

    it("handles bare ~ in PI_CODING_AGENT_DIR", () => {
      process.env.PI_CODING_AGENT_DIR = "~";
      expect(getAgentDir()).toBe(os.homedir());
    });
  });

  describe("findSkill", () => {
    it("finds skill in agent skills directory", () => {
      const gitSkillDir = path.join(skillDir, "git");
      fs.mkdirSync(gitSkillDir, { recursive: true });
      fs.writeFileSync(
        path.join(gitSkillDir, "SKILL.md"),
        "---\nname: git\ndescription: git workflows\n---\n\nContent.",
      );

      // Mock getAgentDir to use our tmp dir
      const agentDir = path.join(tmpDir, "agent");
      fs.mkdirSync(path.join(agentDir, "skills", "git"), { recursive: true });
      fs.writeFileSync(
        path.join(agentDir, "skills", "git", "SKILL.md"),
        "---\nname: git\ndescription: git workflows\n---\n\nContent.",
      );

      process.env.PI_CODING_AGENT_DIR = agentDir;
      const result = findSkill("git", tmpDir);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("git");
      expect(result!.filePath).toContain("git/SKILL.md");
    });

    it("returns null for non-existent skill", () => {
      process.env.PI_CODING_AGENT_DIR = tmpDir;
      const result = findSkill("nonexistent", tmpDir);
      expect(result).toBeNull();
    });

    it("finds project-local skill in .pi/skills", () => {
      const localSkillDir = path.join(tmpDir, ".pi", "skills", "local-skill");
      fs.mkdirSync(localSkillDir, { recursive: true });
      fs.writeFileSync(
        path.join(localSkillDir, "SKILL.md"),
        "---\nname: local-skill\n---\n\nLocal content.",
      );

      process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, "no-skills");
      const result = findSkill("local-skill", tmpDir);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("local-skill");
      expect(result!.filePath).toContain(".pi/skills/local-skill/SKILL.md");
    });
  });

  describe("listAvailableSkills", () => {
    it("lists skills from multiple directories", () => {
      // Create skills in agent dir
      const agentSkillsDir = path.join(tmpDir, "agent", "skills");
      fs.mkdirSync(path.join(agentSkillsDir, "git"), { recursive: true });
      fs.writeFileSync(path.join(agentSkillsDir, "git", "SKILL.md"), "---\nname: git\n---\n");

      // Create skills in project-local dir
      const localSkillsDir = path.join(tmpDir, ".pi", "skills");
      fs.mkdirSync(path.join(localSkillsDir, "test"), { recursive: true });
      fs.writeFileSync(path.join(localSkillsDir, "test", "SKILL.md"), "---\nname: test\n---\n");

      process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, "agent");
      const result = listAvailableSkills(tmpDir);
      expect(result.sort()).toEqual(["git", "test"]);
    });

    it("returns empty array when no skills found", () => {
      process.env.PI_CODING_AGENT_DIR = tmpDir;
      const result = listAvailableSkills(tmpDir);
      expect(result).toEqual([]);
    });

    it("deduplicates skills with same name", () => {
      // Create same-named skill in both locations
      const agentSkillsDir = path.join(tmpDir, "agent", "skills");
      fs.mkdirSync(path.join(agentSkillsDir, "git"), { recursive: true });
      fs.writeFileSync(path.join(agentSkillsDir, "git", "SKILL.md"), "---\nname: git\n---\n");

      const localSkillsDir = path.join(tmpDir, ".pi", "skills");
      fs.mkdirSync(path.join(localSkillsDir, "git"), { recursive: true });
      fs.writeFileSync(path.join(localSkillsDir, "git", "SKILL.md"), "---\nname: git\n---\n");

      process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, "agent");
      const result = listAvailableSkills(tmpDir);
      expect(result).toEqual(["git"]);
    });
  });

  describe("collectSkillFiles", () => {
    it("collects files excluding SKILL.md and dotfiles", () => {
      const skillDir = path.join(tmpDir, "my-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\n---\n");
      fs.writeFileSync(path.join(skillDir, "script.sh"), "#!/bin/bash\necho hi");
      fs.writeFileSync(path.join(skillDir, ".hidden"), "hidden file");
      fs.mkdirSync(path.join(skillDir, "subdir"), { recursive: true });
      fs.writeFileSync(path.join(skillDir, "subdir", "ref.md"), "Reference doc");

      const result = collectSkillFiles(skillDir);
      expect(result.sort()).toEqual(
        [path.join(skillDir, "script.sh"), path.join(skillDir, "subdir", "ref.md")].sort(),
      );
    });

    it("skips node_modules directories", () => {
      const skillDir = path.join(tmpDir, "my-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.mkdirSync(path.join(skillDir, "node_modules", "pkg"), { recursive: true });
      fs.writeFileSync(path.join(skillDir, "node_modules", "pkg", "index.js"), "module.exports");
      fs.writeFileSync(path.join(skillDir, "script.sh"), "#!/bin/bash");

      const result = collectSkillFiles(skillDir);
      expect(result).toEqual([path.join(skillDir, "script.sh")]);
    });

    it("returns empty array for empty directory", () => {
      const emptyDir = path.join(tmpDir, "empty-skill");
      fs.mkdirSync(emptyDir, { recursive: true });
      const result = collectSkillFiles(emptyDir);
      expect(result).toEqual([]);
    });
  });
});

describe("tool execution (real tmpdir)", () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-exec-test-"));
    originalEnv = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv !== undefined) {
      process.env.PI_CODING_AGENT_DIR = originalEnv;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  });

  it("returns skill content with loaded_skill format", async () => {
    const agentDir = path.join(tmpDir, "agent");
    const skillDir = path.join(agentDir, "skills", "test-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: test-skill\ndescription: A test skill\n---\n\nThis is the skill body.",
    );

    process.env.PI_CODING_AGENT_DIR = agentDir;

    const tool = createSkillTool();
    const ctx = { cwd: tmpDir } as any;
    const result = await tool.execute!("tc-1", { name: "test-skill" }, undefined as any, undefined as any, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain('<loaded_skill name="test-skill">');
    expect(result.content[0].text).toContain("This is the skill body.");
    expect(result.content[0].text).toContain("</loaded_skill>");
  });

  it("returns error for non-existent skill", async () => {
    process.env.PI_CODING_AGENT_DIR = tmpDir;

    const tool = createSkillTool();
    const ctx = { cwd: tmpDir } as any;
    const result = await tool.execute!("tc-1", { name: "nonexistent" }, undefined as any, undefined as any, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('skill "nonexistent" not found');
  });

  it("lists available skills in error message", async () => {
    const agentDir = path.join(tmpDir, "agent");
    const skillDir = path.join(agentDir, "skills");
    fs.mkdirSync(path.join(skillDir, "git"), { recursive: true });
    fs.writeFileSync(path.join(skillDir, "git", "SKILL.md"), "---\nname: git\n---\n");
    fs.mkdirSync(path.join(skillDir, "test"), { recursive: true });
    fs.writeFileSync(path.join(skillDir, "test", "SKILL.md"), "---\nname: test\n---\n");

    process.env.PI_CODING_AGENT_DIR = agentDir;

    const tool = createSkillTool();
    const ctx = { cwd: tmpDir } as any;
    const result = await tool.execute!("tc-1", { name: "missing" }, undefined as any, undefined as any, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("available skills:");
    expect(result.content[0].text).toContain("git");
    expect(result.content[0].text).toContain("test");
  });

  it("includes skill files in output", async () => {
    const agentDir = path.join(tmpDir, "agent");
    const skillDir = path.join(agentDir, "skills", "files-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: files-skill\n---\n\nBody.");
    fs.writeFileSync(path.join(skillDir, "script.sh"), "#!/bin/bash");
    fs.mkdirSync(path.join(skillDir, "refs"), { recursive: true });
    fs.writeFileSync(path.join(skillDir, "refs", "guide.md"), "Guide");

    process.env.PI_CODING_AGENT_DIR = agentDir;

    const tool = createSkillTool();
    const ctx = { cwd: tmpDir } as any;
    const result = await tool.execute!("tc-1", { name: "files-skill" }, undefined as any, undefined as any, ctx);

    expect(result.content[0].text).toContain("<skill_files>");
    expect(result.content[0].text).toContain("<file>");
    expect(result.content[0].text).toContain("script.sh");
    expect(result.content[0].text).toContain("guide.md");
    expect(result.content[0].text).toContain("</skill_files>");
  });
});
