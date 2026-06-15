/**
 * skill tool — load a skill by name, returning its content for
 * injection into the conversation context.
 *
 * uses pi's native skill discovery (loadSkills) + frontmatter parsing
 * instead of custom implementations.
 *
 * the model calls `skill(name: "git")` instead of reading SKILL.md
 * paths manually. files in the skill directory are listed in
 * <skill_files> for the model to read if needed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ToolDefinition,
  Skill,
} from "@earendil-works/pi-coding-agent";
import {
  parseFrontmatter,
  loadSkills,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { withPromptPatch } from "@bds_pi/prompt-patch";
import {
  boxRendererWindowed,
  textSection,
  type Excerpt,
} from "@bds_pi/box-format";

const COLLAPSED_EXCERPTS: Excerpt[] = [
  { focus: "head" as const, context: 3 },
  { focus: "tail" as const, context: 5 },
];

// --- skill discovery via pi ---

/**
 * get custom skill paths from settings.json.
 */
function getSkillPathsFromSettings(): string[] {
  const settingsPath = path.join(getAgentDir(), "settings.json");
  if (!fs.existsSync(settingsPath)) return [];
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    if (Array.isArray(settings.skills)) {
      return settings.skills.map((p: string) => {
        if (p === "~") return require("node:os").homedir();
        if (p.startsWith("~/")) return require("node:os").homedir() + p.slice(1);
        return p;
      });
    }
  } catch {
    /* unreadable */
  }
  return [];
}

/**
 * find a skill by name using pi's native skill discovery.
 * returns the pi Skill object with name, filePath, baseDir, etc.
 */
function findSkill(name: string, cwd: string): Skill | null {
  const { skills } = loadSkills({
    cwd,
    agentDir: getAgentDir(),
    skillPaths: getSkillPathsFromSettings(),
    includeDefaults: true,
  });
  return skills.find((s) => s.name === name) ?? null;
}

/**
 * list all known skill names for error messages.
 */
function listAvailableSkills(cwd: string): string[] {
  const { skills } = loadSkills({
    cwd,
    agentDir: getAgentDir(),
    skillPaths: getSkillPathsFromSettings(),
    includeDefaults: true,
  });
  return skills.map((s) => s.name).sort();
}

/**
 * collect file paths in the skill directory (excluding SKILL.md),
 * walking subdirectories. used for the <skill_files> block so the
 * model knows what reference files are available.
 */
function collectSkillFiles(baseDir: string): string[] {
  const files: string[] = [];

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name !== "SKILL.md") {
        files.push(full);
      }
    }
  }

  walk(baseDir);
  return files;
}

// --- tool factory ---

interface SkillParams {
  name: string;
  arguments?: string;
}

export function createSkillTool(): ToolDefinition<any> {
  return {
    name: "skill",
    label: "Load Skill",
    description:
      "Load a specialized skill that provides domain-specific instructions and workflows.\n\n" +
      "When you recognize that a task matches one of the available skills, use this tool " +
      "to load the full skill instructions.\n\n" +
      "The skill will inject detailed instructions, workflows, and access to bundled " +
      "resources (scripts, references, templates) into the conversation context.",

    parameters: Type.Object({
      name: Type.String({
        description:
          "The name of the skill to load (must match one of the available skills).",
      }),
      arguments: Type.Optional(
        Type.String({
          description: "Optional arguments to pass to the skill.",
        }),
      ),
    }),

    renderCall(args: any, theme: any) {
      const name = args.name || "...";
      return new Text(
        theme.fg("dim", "using ") +
          theme.fg("toolTitle", theme.bold(name)) +
          theme.fg("dim", " skill"),
        0,
        0,
      );
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as SkillParams;
      const skill = findSkill(p.name, ctx.cwd);

      if (!skill) {
        const available = listAvailableSkills(ctx.cwd);
        const list =
          available.length > 0
            ? `\n\navailable skills: ${available.join(", ")}`
            : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `skill "${p.name}" not found.${list}`,
            },
          ],
          isError: true,
        } as any;
      }

      let rawContent: string;
      try {
        rawContent = fs.readFileSync(skill.filePath, "utf-8");
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `failed to read skill file: ${err.message}`,
            },
          ],
          isError: true,
        } as any;
      }

      const { body } = parseFrontmatter(rawContent);

      // build output in <loaded_skill> format
      const parts: string[] = [
        `<loaded_skill name="${skill.name}">`,
        body,
        "",
        `Base directory for this skill: file://${skill.baseDir}`,
        "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
      ];

      const skillFiles = collectSkillFiles(skill.baseDir);
      if (skillFiles.length > 0) {
        parts.push("");
        parts.push("<skill_files>");
        for (const f of skillFiles) {
          parts.push(`<file>${f}</file>`);
        }
        parts.push("</skill_files>");
      }

      parts.push("</loaded_skill>");

      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
        details: { header: skill.name },
      } as any;
    },

    renderResult(
      result: any,
      { expanded }: { expanded: boolean },
      _theme: any,
    ) {
      const content = result.content?.[0];
      if (!content || content.type !== "text")
        return new Text("(no output)", 0, 0);
      if (content.text.startsWith("<loaded_skill")) {
        return boxRendererWindowed(
          () => [textSection(undefined, "skill loaded", true)],
          { collapsed: {}, expanded: {} },
          undefined,
          expanded,
        );
      }
      return boxRendererWindowed(
        () => [textSection(undefined, content.text)],
        {
          collapsed: { excerpts: COLLAPSED_EXCERPTS },
          expanded: {},
        },
        undefined,
        expanded,
      );
    },
  };
}

// --- exports for testing ---

export {
  getSkillPathsFromSettings,
  findSkill,
  listAvailableSkills,
  collectSkillFiles,
};

// --- extension entry point ---

export default function (pi: ExtensionAPI): void {
  pi.registerTool(withPromptPatch(createSkillTool()));
}


