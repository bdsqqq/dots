import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getCommitIndex,
  lookupCommitByPrefix,
  MentionAutocompleteProvider,
  parseMentions,
  resolveGitRoot,
  type MentionSource,
  type MentionSourceContext,
} from "@bds_pi/mentions";

function isGitEnabled(context: MentionSourceContext): boolean {
  return context.gitEnabled ?? resolveGitRoot(context.cwd) !== null;
}

function createCommitMentionSource(): MentionSource {
  return {
    kind: "commit",
    description: "git commit",
    isEnabled: (context) => isGitEnabled(context),
    getSuggestions(query, context) {
      if (!isGitEnabled(context)) return [];
      const index = context.commitIndex ?? getCommitIndex(context.cwd);
      if (!index) return [];

      return index.commits
        .filter(
          (commit) =>
            query.length === 0 || commit.sha.startsWith(query.toLowerCase()),
        )
        .slice(0, 8)
        .map((commit) => ({
          value: `@commit/${commit.shortSha}`,
          label: `@commit/${commit.shortSha}`,
          description: commit.subject,
        }));
    },
    resolve(token, context) {
      const index = context.commitIndex ?? getCommitIndex(context.cwd);
      if (!index) {
        return {
          token,
          status: "unresolved",
          reason: "git_repository_not_found",
        };
      }

      const result = lookupCommitByPrefix(token.value, index);
      if (result.status === "resolved") {
        return {
          token,
          status: "resolved",
          kind: "commit",
          commit: result.commit,
        };
      }

      return {
        token,
        status: "unresolved",
        reason:
          result.status === "ambiguous"
            ? "commit_prefix_ambiguous"
            : "commit_not_found",
      };
    },
  };
}

export function createGitExtension() {
  return function gitExtension(pi: ExtensionAPI): void {
    const source = createCommitMentionSource();

    pi.on("session_start", async (_event, ctx) => {
      if (!ctx.hasUI) return;
      ctx.ui.addAutocompleteProvider(
        (baseProvider) =>
          new MentionAutocompleteProvider({
            baseProvider,
            source,
            context: { cwd: ctx.cwd },
          }),
      );
    });

    pi.on("before_agent_start", async (event) => {
      if (!parseMentions(event.prompt).some((mention) => mention.kind === "commit")) {
        return;
      }

      return {
        systemPrompt:
          event.systemPrompt +
          "\n\nWhen the user includes `@commit/<sha-or-prefix>`, treat it as a pointer to a git commit in the current repository. Resolve it with git commands such as `git show` or `git log` before relying on its contents.",
      };
    });
  };
}

const gitExtension: (pi: ExtensionAPI) => void = createGitExtension();

export default gitExtension;
