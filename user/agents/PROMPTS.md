# prompts

collection of system prompts, tool definitions, and agent configs for subagents.
some derived from studying existing implementations, others written from scratch.

## naming convention

```
(type).(origin).(name).md
```

**type** — what the file describes:

| type | meaning | body format |
|---|---|---|
| `agent` | subagent definition | pi-compatible frontmatter (`name`, `description`, `tools`, `model`) + system prompt body |
| `tool` | tool/function spec | tool schema, input params, description. reference only — not directly loadable |
| `skill` | skill definition | multi-step workflows, subagent orchestration patterns. reference only |
| `prompt` | raw system prompt | full prompt text. no pi frontmatter — these are templates, not executable |

**origin** — provenance tag (freeform)

**name** — what it is (`researcher`, `handoff`, `system`, etc.)

`agent.*` files may use frontmatter to hint usage for integrations.
this convention is loosely consistent across tools like pi, and cursor.

```yaml
---
name: researcher                    # Unique identifier.
description: short description      # When to use this specubagent.
tools: read, grep, find, ls, bash   # comma-separated tool names.
model: gpt-5.2                      # model-id.
---
```

The body of the file 

sometimes, it's very useful to interpolate variables in the


## encryption

all prompts are packed into a single sops-encrypted YAML blob (`prompts.yaml`). the blob uses **opaque numeric keys** — no filenames appear anywhere in the public repo (not in git tree, nix source, or YAML keys).

structure (flat keys — sops-nix can't traverse nested structures):

```yaml
"0-filename": type.origin.name.md
"0-content": |
  ---
  frontmatter
  ---
  body
"1-filename": ...
"1-content": |
  ...
```

all values are sops-encrypted. keys are quoted opaque numeric IDs with `-filename`/`-content` suffixes. the `.sops.yaml` creation rule matches `user/agents/prompts\.(json|yaml)$`. `system/sops.nix` uses `format = "yaml"` with flat keys.

### adding a new prompt

```bash
# 1. edit the blob (opens decrypted YAML in $EDITOR, re-encrypts on save)
sops user/agents/prompts.yaml

# 2. add a new entry with the next numeric key:
#    "N-filename": "type.origin.name.md"
#    "N-content": |
#      ---
#      frontmatter
#      ---
#      body

# 3. bump promptCount in system/sops.nix to match total entry count

# 4. verify build
nix build .#darwinConfigurations.mbp-m2.system --dry-run

# 5. commit
git add user/agents/prompts.yaml system/sops.nix
```

### editing an existing prompt

```bash
# opens decrypted YAML in $EDITOR, re-encrypts on save
sops user/agents/prompts.yaml
```

no nix changes needed — only the blob changes.

### how it works at runtime

`system/sops.nix` declares `sops.secrets."prompt-N-filename"` and `sops.secrets."prompt-N-content"` for each N in 0..promptCount-1, using `key = "N-filename"` and `key = "N-content"` to extract flat values from the YAML blob (`format = "yaml"`). sops-nix decrypts each to `/run/secrets/prompt-N-filename` and `/run/secrets/prompt-N-content` at activation time.

a launchd daemon (darwin) or systemd service (linux) then unpacks these into `~/.config/agents/prompts/`:

1. cleans existing `*.md` files from the destination
2. for each N, reads the decrypted filename and content from `/run/secrets/`
3. writes content to `~/.config/agents/prompts/$FILENAME` with owner bdsqqq, mode 0400

on darwin, the daemon watches `/run/secrets/prompt-0-filename` via `KeepAlive.PathState` so it re-runs when secrets change. on linux, it runs as a oneshot after `sops-install-secrets.service`.

pi's sub-agents extension discovers agent files via `~/.pi/agent/agents` → `~/.config/agents/prompts`.

### tradeoffs vs. individual files

- **pro**: git tree reveals nothing about inventory — no filenames, no count, no keys
- **pro**: adding/removing prompts only requires editing the blob + bumping one number in `system/sops.nix`
- **con**: editing still requires sops + YAML (multiline via `|` blocks)
- **con**: runtime depends on an unpack daemon — secrets aren't available as plain files until it runs

## usage

agent files: discovered automatically from `~/.config/agents/prompts/` after system activation + unpack daemon run.

everything else: reference material. read these when building your own tools, prompts, or extensions. use `sops user/agents/prompts.yaml` to view/edit.
