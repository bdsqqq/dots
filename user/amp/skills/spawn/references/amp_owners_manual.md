---
source: "https://ampcode.com/manual"
---
## Congratulations on installing Amp. This manual helps you get the most out of it.

## Why Amp?

Amp is the frontier coding agent for your terminal and editor.

- **Multi-Model:** Opus 4.5, GPT-5.1, fast models—Amp uses them all, for what each model is best at.
- **Opinionated:** You're always using the good parts of Amp. If we don't use and love a feature, we kill it.
- **On the Frontier:** Amp goes where the models take it. No backcompat, no legacy features.
- **Threads:** You can save and share your interactions with Amp. You wouldn't code without version control, would you?

Amp has 3 modes: `smart` (unconstrained state-of-the-art model use), `rush` (faster, cheaper, suited for small, well-defined tasks), and `free` (free of charge, using fast basic models).

*Want to go much deeper? Watch our [Raising an Agent podcast](https://ampcode.com/podcast) that chronicles the first few months of building Amp, and see our [FIF](https://ampcode.com/fif).*

<video controls="controls" width="768" height="551"><source src="https://static.ampcode.com/content/amp-cli-20251026-0.mp4" type="video/mp4"></video> ![Amp in VS Code](https://static.ampcode.com/content/amp-vscode-1.png)

## Get Started

1. Sign into [ampcode.com/install](https://ampcode.com/install).
2. Follow the instructions to install the Amp CLI and editor extensions for VS Code, Cursor, JetBrains, Neovim, and other editors.

You're ready to [start using Amp](https://ampcode.com/#usage)!

  
  

### From the Command Line

Our recommended install method for macOS, Linux and WSL. It supports auto-updating and fast launch via Bun.

Install the Amp CLI:

```bash
curl -fsSL https://ampcode.com/install.sh | bash
```

Run interactively (will prompt for login on first run):

```bash
amp
```

You can also [install via npm](https://www.npmjs.com/package/@sourcegraph/amp) if necessary.

### From Your Editor

Sign into [ampcode.com/install](https://ampcode.com/install) and follow the instructions, or:

- **VS Code and Cursor (and other forks):** Install the `sourcegraph.amp` extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=sourcegraph.amp) or [Open VSX Registry](https://open-vsx.org/extension/sourcegraph/amp).
- **JetBrains (IntelliJ, WebStorm, GoLand, etc.):** Install the Amp CLI, then run `amp --jetbrains`.
- **Neovim:** Install the Amp CLI and the [Amp Neovim plugin](https://github.com/sourcegraph/amp.nvim), then run `amp`.

## Using Amp

### Agent Modes

Amp has 4 modes:

- **`smart`**: Uses state-of-the-art models without constraints for maximum capability and autonomy.
- **`rush`**: Faster, cheaper, and less capable, suitable for small, well-defined tasks. See [Rush Mode](https://ampcode.com/news/rush-mode).
- **`free`**: Free of charge, using fast basic models. See [Amp Free](https://ampcode.com/#free).

*There's one more that's hidden: [`large` mode](https://ampcode.com/news/large-mode).*

See [Models](https://ampcode.com/models) for the models used by each mode.

Switch modes in the CLI by opening the command palette (Ctrl+O) and typing `mode`, or select the mode in the prompt field of the editor extension.

### How to Prompt

Amp currently uses Claude Opus 4.5 for most tasks, with up to 200k tokens of context. For the best results, follow these guidelines:

- Be explicit with what you want. Instead of "can you do X?", try "do X."
- Keep it short, keep it focused. Break very large tasks up into smaller sub-tasks, one per thread. Do not ask the agent to write database migrations in the same thread as it previously changed CSS for a documentation page.
- Don't try to make the model guess. If you know something about how to achieve what you want the agent to do — which files to look at, which commands to run — put it in your prompt.
- If you want the model to not write any code, but only to research and plan, say so: "Only plan how to implement this. Do NOT write any code."
- Use [`AGENTS.md` files](https://ampcode.com/#AGENTS.md) to guide Amp on how to run your tests and build steps and to avoid common mistakes.
- Abandon threads if they accumulated too much noise. Sometimes things go wrong and failed attempts with error messages clutter up the context window. In those cases, it's often best to start with a new thread and a clean context window.
- Tell the agent how to best review its work: what command or test to run, what URL to open, which logs to read. Feedback helps agents as much as it helps us.

The first prompt in the thread carries a lot of weight. It sets the direction for the rest of the conversation. We encourage you to be deliberate with it. That's why we use Cmd/Ctrl+Enter to submit a message in Amp — it's a reminder to put effort into a prompt.

Here are some examples of prompts we've used with Amp:

- "Make `observeThreadGuidanceFiles` return `Omit<ResolvedGuidanceFile, 'content'>[]` and remove that field from its return value, and update the tests. Note that it is omitted because this is used in places that do not need the file contents, and this saves on data transferred over the view API." ([See Thread](https://ampcode.com/threads/T-9219191b-346b-418a-b521-7dc54fcf7f56))
- "Run `<build command>` and fix all the errors"
- "Look at `<local development server url>` to see this UI component. Then change it so that it looks more minimal. Frequently check your work by screenshotting the URL"
- "Run git blame on the file I have open and figure out who added that new title"
- "Convert these 5 files to use Tailwind, use one subagent per file"
- "Take a look at `git diff` — someone helped me build a debug tool to edit a Thread directly in JSON. Please analyze the code and see how it works and how it can be improved. \[…\]" ([See Thread](https://ampcode.com/threads/T-39dc399d-08cc-4b10-ab17-e6bac8badea7))
- "Check `git diff --staged` and remove the debug statements someone added" ([See Thread](https://ampcode.com/threads/T-66beb0de-7f02-4241-a25e-50c0dc811788))
- "Find the commit that added this using git log, look at the whole commit, then help me change this feature"
- "Explain the relationship between class AutoScroller and ViewUpdater using a diagram"
- "Run `psql` and rewire all the `threads` in the databaser to my user (email starts with thorsten)" ([See Thread](https://ampcode.com/threads/T-f810ef79-ba0e-4338-87c6-dbbb9085400a))

Also see Thorsten Ball's [How I Use Amp](https://ampcode.com/how-i-use-amp).

If you're in a workspace, use Amp's [thread sharing](https://ampcode.com/#thread-sharing) to learn from each other.

### AGENTS.md

Amp looks in `AGENTS.md` files for guidance on codebase structure, build/test commands, and conventions.

| File | Examples |
| --- | --- |
| `AGENTS.md`   in cwd, parent dirs, & subtrees | Architecture, build/test commands, overview of internal APIs, review and release steps |
| `$HOME/.config/amp/AGENTS.md`   `$HOME/.config/AGENTS.md` | Personal preferences, device-specific commands, and guidance that you're testing locally before committing to your repository |

Amp includes `AGENTS.md` files automatically:

- `AGENTS.md` files in the current working directory (or editor workspace roots) *and* parent directories (up to `$HOME`) are always included.
- Subtree `AGENTS.md` files are included when the agent reads a file in the subtree.
- Both `$HOME/.config/amp/AGENTS.md` and `$HOME/.config/AGENTS.md` are included if they exist.

If no `AGENTS.md` exists in a directory, but a file named `AGENT.md` (without an `S`) or `CLAUDE.md` does exist, that file will be included.

In a large repository with multiple subprojects, we recommend keeping the top-level `AGENTS.md` general and creating more specific `AGENTS.md` files in subtrees for each subproject.

To see the agent files that Amp is using, run `/agent-files` (CLI) or hover the X% of 968k indicator after you've sent the first message in a thread (editor extension).

#### Writing AGENTS.md Files

Amp offers to generate an `AGENTS.md` file for you if none exists. You can create or update any `AGENTS.md` files manually or by asking Amp (*"Update AGENTS.md based on what I told you in this thread"*).

To include other files as context, @-mention them in agent files. For example:

```markdown
See @doc/style.md and @specs/**/*.md.

When making commits, see @doc/git-commit-instructions.md.
```
- Relative paths are interpreted relative to the agent file containing the mention.
- Absolute paths and `@~/some/path` are also supported.
- @-mentions in code blocks are ignored, to avoid false positives.
- Glob patterns are supported (such as `@doc/*.md` or `@.agent/**/*.md`).

#### Granular Guidance

To provide guidance that only applies when working with certain files, you can specify `globs` in YAML front matter of mentioned files.

For example, to apply language-specific coding rules:

1. Put `See @docs/*.md` anywhere in your `AGENTS.md` file.
2. Create a file `docs/typescript-conventions.md` with:
	```markdown
	---
	globs:
	  - '**/*.ts'
	  - '**/*.tsx'
	---
	Follow these TypeScript conventions:
	- Never use the \`any\` type
	- ...
	```
3. Repeat for other languages.

Mentioned files with `globs` will only be included if Amp has read a file matching any of the globs (in the example above, any TypeScript file). If no `globs` are specified, the file is always included when @-mentioned.

Globs are implicitly prefixed with `**/` unless they start with `../` or `./`, in which case they refer to paths relative to the mentioned file.

Other examples:

- Frontend-specific guidance: `globs: ["src/components/**", "**/*.tsx"]`
- Backend guidance: `globs: ["server/**", "api/**"]`
- Test guidance: `globs: ["*.test.ts", "__tests__/*"]`

#### Migrating to AGENTS.md

- From Claude Code: `mv CLAUDE.md AGENTS.md && ln -s AGENTS.md CLAUDE.md`, and repeat for subtree `CLAUDE.md` files
- From Cursor: `mv .cursorrules AGENTS.md && ln -s AGENTS.md .cursorrules` and then add `@.cursor/rules/*.mdc` anywhere in `AGENTS.md` to include all Cursor rules files.
- From existing AGENT.md: `mv AGENT.md AGENTS.md` (optional - both filenames continue to work)

### Handoff

Amp works best when you keep threads small and focused on a single task

To continue your work from one thread in a new thread, use the `handoff` command from the command palette to draft a new thread with relevant files and context from the original thread.

Provide some help to the handoff command to direct the new prompt. For example:

- `now implement this for teams as well, not just individual users`
- `execute phase one of the created plan`
- `check the rest of the codebase and find other places that need this fix`

See [Handoff (No More Compaction)](https://ampcode.com/news/handoff) for why Amp doesn't support compaction.

### Referencing Other Threads

You can reference other Amp threads by thread URL (e.g., `https://ampcode.com/threads/T-7f395a45-7fae-4983-8de0-d02e61d30183`) or thread ID (e.g., `@T-7f395a45-7fae-4983-8de0-d02e61d30183`) in your prompt.

Type @@ to search for a thread to mention.

For each mentioned thread, Amp will read and extract relevant information to your current task. This is useful to continue work from or reuse techniques from a previous thread.

Examples:

- `Implement the plan from https://ampcode.com/threads/T-7f395a45-7fae-4983-8de0-d02e61d30183`
- `Apply the same fix from @T-7f395a45-7fae-4983-8de0-d02e61d30183 to the form here`

### Archiving Threads

When you archive a thread, it no longer appears in your list of active threads but can still be viewed on the web and [referenced by @-mention](https://ampcode.com/#referencing-threads).

To archive a thread, from the command palette, run `thread: archive and exit` in the CLI or `Thread: Archive` in the editor extension.

### Attaching Images

You can attach images (such as screenshots and diagrams) to your messages.

In the CLI, press Ctrl+V to paste an image from the clipboard. Note that you must use Ctrl+V, not Cmd+V, even on macOS.

In the editor extension, paste an image using Cmd+V / Ctrl+V, or hold Shift and drag an image over the message field.

You can also @-mention images by file path.

### Mentioning Files

Type @ to search for a file to mention.

### Edit & Undo

Editing a prior message in a thread automatically reverts any changes the agent made *after* that message.

To edit a prior message in the CLI, press Tab to navigate to prior messages. In the editor extension, scroll up in the thread and click on a prior message.

You can also revert individual file changes by clicking the `N files changed` indicator.

### Queueing Messages

You can queue messages to be sent to the agent once it ends its turn, without interrupting its current work. To queue a message:

- In the editor extension, type your message and press Cmd-Shift-Enter (macOS) or Ctrl-Shift-Enter (Windows/Linux).
- In the CLI, use the `queue` command from the command palette.

### Custom Commands

Custom commands let you define reusable prompts and automations for Amp. For more information, see [Custom Commands](https://ampcode.com/news/custom-commands).

### Skills

Custom commands were deprecated in December 2025, but remain supported. The preferred way to guide Amp is via Skills.

Skills are structured, reusable configurations for Amp that can be stored in `.skill/` directories or referenced from `AGENTS.md` files. They contain:

- A skill definition file (e.g., `SKILL.md`) that describes the skill and includes instructions
- Optional templates, helper scripts, and other resources

Skills can be:

- Personal: stored in `~/.config/amp/skills/<skill-name>/`
- Shared: stored in `<project-root>/.skill/<skill-name>/`

Use skills to:

- Guide Amp through complex, multi-step workflows
- Standardize common operations across a team
- Encapsulate domain-specific knowledge and procedures

When an agent loads a skill, it gains access to the skill's instructions and bundled resources.

For more details, see the [Skills specification](https://agentskills.io/specification).

### Permissions

You can configure Amp to ask for permission before running certain tools, automatically allow certain tools, or automatically reject certain tools. This is useful for controlling which actions Amp can take without your approval.

Amp's permission rules have 3 components:

- **tool** (required): The tool to match against.
- **action** (required): What to do when the tool matches. One of `allow`, `ask`, or `reject`.
- **condition** (optional): An additional condition to match against the tool's input.

Permission rules are evaluated in the order in which they are defined. The first matching rule is used.

To configure permissions, add `amp.permissions` to your settings:

```json
{
  "amp.permissions": [
    // For Bash, ask for approval only if the command matches the regex
    { "tool": "Bash", "action": "allow", "condition": { "cmd": { "not-regex": "(rm|sudo|mv|chmod|chown|dd|mkfs|kill|pkill|reboot|shutdown|curl.*\\|)" } } },
    { "tool": "Bash", "action": "ask" },

    // For edit_file, allow all edits outside of the src/security/** directory
    { "tool": "edit_file", "action": "reject", "condition": { "path": { "glob": "**/src/security/**" } } },

    // Reject one specific tool
    { "tool": "read_web_page", "action": "reject" },

    // For all tools, allow all actions (no approval required)
    { "tool": "*", "action": "allow" }
  ]
}
```

The default permissions reject `git push` (and related) commands from Bash. If you want to allow pushing to a remote, you'll need to create a permissions rule to allow it. For example:

```json
{ "tool": "Bash", "action": "allow", "condition": { "cmd": { "regex": "^git push" } } },
```

See [Configuring Permissions](https://ampcode.com/guides/configuring-permissions) for more details.

### Subagents

Subagents (via the `Task` tool) work on sub-tasks of your request and use the same tools as the main agent. Because the subagent's work is summarized, using subagents helps conserve context in the main thread.

Some ways to use subagents:

- "Use a subagent to investigate how we use Redis in this codebase"
- "Convert these 5 files to use Tailwind, use one subagent per file" (you can instruct Amp to run subagents concurrently)
- "Write this API server, update the frontend, and write tests, using different subagents for each sub-task"

### Custom Tools (MCP)

You can add custom tools using the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). For example, you can let the Amp agent use tools to query a database, read your Notion pages, control a browser, run a Puppeteer session, post to Slack, etc.

To configure custom MCP servers, add them to your amp settings file or VS Code settings. For more information, see [Custom Tools with MCP](https://ampcode.com/guides/custom-tools-mcp).

As of late December 2025, Amp's MCP support includes these features:

- **Resources**: Add MCP resources (like files or documents) to the agent's context by @-mentioning them (e.g., `@my-database-mcp:users`). You can also reference MCP resources in AGENTS.md.
- **Prompts**: Use MCP prompts as [custom commands](https://ampcode.com/news/custom-commands). Prompts are added to the command palette with the `/` prefix (e.g., `/my-prompt`).
- **Transports**: Amp supports stdio and SSE (Server-Sent Events) transports.
- **Roots**: Amp sends the Bun-based Node-like runtime it uses internally, see [MCP Filesystem Roots](https://ampcode.com/news/mcp-roots).

### Thread Search

You can search through previous threads using /search in the command palette, or search for threads on the [ampcode.com/threads](https://ampcode.com/threads) page.

To find all threads that touch a particular file, run `amp threads search "file:path/to/file.ts"`.

### Thread Sharing

Threads can be shared with anyone, including non-Amp-users. Click the `Share` button in the CLI or editor extension to get a shareable link.

If you are part of a [workspace](https://ampcode.com/workspace), threads are visible to all members of the workspace by default. Change the visibility of a thread in the `Share` menu.

Workspace threads (threads with workspace or custom visibility) are persisted and archived with the workspace, so members of the workspace can search and view workspace threads of members no longer in the workspace.

Default thread visibility can be configured for the workspace in [workspace settings](https://ampcode.com/workspace), and for yourself in [user settings](https://ampcode.com/settings).

We're adding more fine-grained thread visibility controls. See the [Appendix](https://ampcode.com/manual/appendix#workspace-thread-visibility-controls) for more details.

### Thread Activity

To monitor your Amp usage, you can view your thread activity on the Amp threads page at [ampcode.com/threads](https://ampcode.com/threads). Click on the heatmap to filter by date or date range.

### Workspaces

You and your team can share a pool of credits by creating and joining a workspace on [ampcode.com/workspace](https://ampcode.com/workspace). Workspace credits are used before individual credits.

#### Other Workspace Benefits

Workspaces enable team collaboration for Amp. Benefits include:

- **Thread Sharing**: See threads from other workspace members with workspace-level visibility.
- **Thread Search**: Search threads by content, file paths, and authors.

Workspace owners can configure usage-related alerts, and set default thread visibility for workspace members.

### Editor Integration

#### Diff View

When showing file changes, Amp offers both a custom inline diff view and the editor's built-in diff view. You can toggle between them using the `,` button in the diff toolbar, or change the default in the VS Code setting `amp.diff.style`.

In inline diff view, green lines are additions, red lines are deletions. Click individual added/rejected lines to accept/reject them.

In panel diff view, the view on the left is read-only, the view on the right is editable. Edit the code on the right and save it to accept changes.

#### Amp-Suggested Diagnostics Fixes

**VS Code only**

When the Amp extension is installed, when you hover over a highlighted diagnostic error, you will see a "Fix with Amp" option. Clicking this will open the Amp panel and start a new conversation with context about the error and a request to fix it.

### CLI Features

#### Editor Detection

The CLI automatically detects running Amp VS Code and Cursor extension instances, and can open and highlight files directly in your editor.

The CLI automatically detects when you have an Amp editor extension running in most cases. If you are using JetBrains and run the Amp CLI from a terminal *other than* JetBrains' builtin terminal, you need to run `amp --jetbrains` to detect it.

### Shell Mode

Execute shell commands directly in the CLI by starting your message with `$`. The command and its output will be included in the context window for the next message to the agent.

Use `$$` to activate incognito shell mode, where commands execute but aren't included in the context. This is useful for noisy commands or quick checks you'd normally run in a separate terminal.

### Writing Prompts in the CLI

In modern terminal emulators, such as Ghostty, Wezterm, Kitty, or iTerm2, you can use shift-enter to insert a newline in your prompts.

Additionally you can also use type `\` followed by return to insert a newline.

If you have the environment variable `$EDITOR` set, you can use the `editor` command from the command palette to open your editor to write a prompt.

### Streaming JSON

Amp's CLI supports streaming JSON output format, one object per line on stdout, for programmatic integration and real-time conversation monitoring.

Use the `--stream-json` flag with `--execute` mode to output in stream JSON format instead of plain text.

Basic usage with argument:

```
$ amp --execute "what is 3 + 5?" --stream-json
```

Combining —stream-json with `amp threads continue`:

```
$ amp threads continue --execute "now add 8 to that" --stream-json
```

With stdin input:

```
$ echo "analyze this code" | amp --execute --stream-json
```

You can find [the schema for the JSON output in the Appendix](https://ampcode.com/manual/appendix?preview#message-schema).

Input can be also be provided on stdin with the `--stream-json-input` flag:

```
$ echo '{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "what is 2+2?"
      }
    ]
  }
}' | amp -x --stream-json --stream-json-input
```

The `--stream-json` flag requires `--execute` mode. It cannot be used standalone. And `--stream-json-input` requires `--stream-json`.

When using `--stream-json-input`, the behavior of `--execute` changes in that Amp will only exit once both the assistant is done *and* stdin has been closed.

This allows for programmatic use of the Amp CLI to have conversations with multiple user messages.

```bash
#!/usr/bin/env bash

send_message() {
  local text="$1"
  echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"'$text'"}]}}'
}

{
  send_message "what's 2+2?"
  sleep 10

  send_message "now add 8 to that"
  sleep 10

  send_message "now add 5 to that"
} | amp --execute --stream-json --stream-json-input
```

See the [Appendix](https://ampcode.com/manual/appendix#stream-json-output) for the schema of the output, example output, and more usage examples.

## Configuration

Amp can be configured through settings in your editor extension (e.g. `.vscode/settings.json`) and the CLI configuration file.

The CLI configuration file location varies by operating system:

- macOS: `~/.config/amp/settings.json`
- Linux: `~/.config/amp/settings.json`
- Windows: `%USERPROFILE%\.config\amp\settings.json`

All settings use the `amp.` prefix.

### Settings

#### Editor Extension and CLI

- **`amp.anthropic.thinking.enabled`**
	**Type:**`boolean`, **Default:**`true`
	Enable Claude's extended thinking capabilities
- **`amp.experimental.dojoMode`**
	**Type:**`boolean`, **Default:**`false`
	Enable dojo mode - a learning mode where the agent guides you to discover solutions yourself through Socratic questioning. The agent can read your codebase and search for information, but won't edit files or give direct solutions. Perfect for learning to code or understanding a new codebase.
- **`amp.fuzzy.alwaysIncludePaths`**
	**Type:**`array`, **Default:**`[]`
	Glob patterns for paths that should always be included in fuzzy file search, even if they are gitignored. Useful for build output directories or generated files you want to reference with `@` mentions.
	Examples: `["dist/**", "node_modules/@myorg/**"]`
- **`amp.permissions`**
	**Type:**`array`, **Default:**`[]`
	Configures which tool uses are allowed, rejected or ask for approval. See [Permissions](https://ampcode.com/#permissions).
- **`amp.tab.clipboard.enabled`**
	**Type:**`boolean`, **Default:**`true`
	Enable clipboard access for Amp Tab context
- **`amp.git.commit.ampThread.enabled`**
	**Type:**`boolean`, **Default:**`true`
	Enable adding Amp-Thread trailer in git commits. When disabled, commits made with the commit tool will not include the `Amp-Thread: <thread-url>` trailer.
- **`amp.git.commit.coauthor.enabled`**
	**Type:**`boolean`, **Default:**`true`
	Enable adding Amp as co-author in git commits. When disabled, commits made with the commit tool will not include the `Co-authored-by: Amp <amp@ampcode.com>` trailer.
- **`amp.mcpServers`**
	**Type:**`object`
	Model Context Protocol servers that expose tools. See [Custom Tools (MCP) documentation](https://ampcode.com/#mcp).
- **`amp.notifications.enabled`**
	**Type:**`boolean`, **Default:**`true`
	Play notification sounds when the agent completes a task or is blocked waiting for user input.
- **`amp.terminal.commands.nodeSpawn.loadProfile`**
	**Type:**`string`, **Default:**`"always"`, **Options:**`"always"` | `"never"` | `"daily"`
	Before running commands (including MCP servers), whether to load environment variables from the user's profile (`.bashrc`, `.zshrc`, `.envrc`) as visible from the workspace root directory
- **`amp.todos.enabled`**
	**Type:**`boolean`, **Default:**`true`
	Enable TODOs tracking for managing tasks
- **`amp.tools.disable`**
	**Type:**`array`, **Default:**`[]`
	Disable specific tools by name. Use 'builtin:toolname' to disable only the builtin tool with that name (allowing an MCP server to provide a tool by that name). Glob patterns using `*` are supported.
- **`amp.tools.stopTimeout`**
	**Type:**`number`, **Default:**`300`
	How many seconds to wait before canceling a running tool
- **`amp.mcpPermissions`**
	**Type:**`array`, **Default:**`[]`
	Allow or block MCP servers that match a designated pattern. The first rule that matches is applied. If no rule matches an MCP server, the server will be allowed.
	- **Remote MCP server**: Use the `url` key to specify a matching criterion for the server endpoint
	- **Local MCP server**: Use the `command` and `args` keys to match an executable command and its arguments
	Here are some examples:
	```json
	"amp.mcpPermissions": [
	  // Allow specific trusted MCP servers
	  { "matches": { "command": "npx", "args": "* @playwright/mcp@*" }, "action": "allow" },
	  { "matches": { "url": "https://mcp.trusted.com/mcp" }, "action": "allow" },
	  // Block potentially risky MCP servers
	  { "matches": { "command": "python", "args": "*bad_command*" }, "action": "reject" },
	  { "matches": { "url": "*/malicious.com*" }, "action": "reject" },
	]
	```
	The following rules will block all MCP servers:
	```json
	"amp.mcpPermissions": [
	  { "matches": { "command": "*" }, "action": "reject" },
	  { "matches": { "url": "*" }, "action": "reject" }
	]
	```

#### CLI-only

- **`amp.updates.mode`**
	**Type:**`string`, **Default:**`"auto"`
	Control update checking behavior: `"warn"` shows update notifications, `"disabled"` turns off checking, `"auto"` automatically runs update. Note: Setting `AMP_SKIP_UPDATE_CHECK=1` environment variable will override this setting and disable all update checking.

### Enterprise Managed Settings

[Enterprise](https://ampcode.com/#enterprise) workspace administrators can enforce settings that override user and workspace settings by deploying their policies to the following locations on machines running Amp:

- **macOS**: `/Library/Application Support/ampcode/managed-settings.json`
- **Linux**: `/etc/ampcode/managed-settings.json`
- **Windows**: `C:\ProgramData\ampcode\managed-settings.json`

This managed settings file uses the same schema as [regular settings](https://ampcode.com/#core-settings) files, with one additional field:

amp.admin.compatibilityDate `string`

### Proxies and Certificates

When using the Amp CLI in corporate networks with proxy servers or custom certificates, set these standard Node.js environment variables in your shell profile or CI environment as needed:

```bash
export HTTP_PROXY=your-proxy-url
export HTTPS_PROXY=your-proxy-url
export NODE_EXTRA_CA_CERTS=/path/to/your/certificates.pem
```

## Pricing

### Free

Amp's `free` mode is free of charge and supported by ads. It uses a mix of top OSS models, frontier models with limited context windows, and pre-release frontier models in testing.

The `free` mode meets all of the stringent [security standards](https://ampcode.com/security) of Amp's paid smart mode. You are not required to share your data for training.

To use it: `/mode free` in the Amp CLI, or select the `free` mode in the prompt field of the Amp editor extension (instead of the paid `smart` mode).

One account per person. Any behavior that looks like circumventing your usage limits or violating our [Acceptable Use Policy](https://ampcode.com/terms/aup) will result in your account being suspended.

See the [Amp Free announcement](https://ampcode.com/news/amp-free) and [Use Amp Free at Work](https://ampcode.com/news/amp-free-no-training) for more information.

### Paid Usage

Amp's default `smart` mode is more autonomous and capable than `free`, and it uses paid credits.

You can buy more credits in [user settings](https://ampcode.com/settings) for yourself, or for your team in [workspace settings](https://ampcode.com/workspace). Upon signup, most users receive $10 USD in free credits.

Usage is consumed based on LLM usage and usage of certain other tools (like web search) that cost us to serve. We pass these costs through to you directly with no markup, for individuals and non-enterprise workspaces.

Workspace credits are pooled and shared by all workspace members. All unused credits expire after one year of account inactivity.

### Enterprise

Enterprise usage is 50% more expensive than individual and team plans, and includes access to:

- SSO (Okta, SAML, etc.) and directory sync
- Zero data retention for text inputs in LLM inference
- Advanced [thread visibility controls](https://ampcode.com/manual/appendix#workspace-thread-visibility-controls)
- [Managed user settings](https://ampcode.com/#enterprise-managed-policy-settings)
- APIs for workspace analytics and data management
- Configurable thread retention (on request)
- IP allowlisting for workspace access (on request)

For more information about Amp Enterprise security features, see the [Amp Security Reference](https://ampcode.com/security).

To start using Amp Enterprise, go to [your workspace](https://ampcode.com/workspace) and click **Plan** in the top right. This requires a special one-time $1,000 USD purchase, which grants your workspace $1,000 USD of Amp Enterprise usage and upgrades your workspace to Enterprise. Amp Enterprise also includes access to:

- [Entitlements](https://ampcode.com/manual/appendix#workspace-entitlements) for per-user cost controls
- User groups for cost attribution and per-group thread visibility options (on request)

Contact [amp-devs@ampcode.com](https://ampcode.com/) for access to these purchasing options and for general information about Amp Enterprise.

## Support

For general help with Amp, post on X and mention [@AmpCode](https://x.com/AmpCode), or email [amp-devs@ampcode.com](https://ampcode.com/). You can also join our community [Build Crew](https://buildcrew.team/) to discuss Amp and share tips with others.

For billing and account help, contact [amp-devs@ampcode.com](https://ampcode.com/).

### Supported Platforms

Amp supports macOS, Linux, and Windows (WSL recommended).

Amp's JetBrains integration supports all JetBrains IDEs (IntelliJ, WebStorm, GoLand, etc.) on versions 2025.1+ (2025.2.2+ is recommended).
