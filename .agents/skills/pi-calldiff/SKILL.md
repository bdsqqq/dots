---
name: pi-calldiff
description: Map control flow plus syntax-level data in/outflow for agentic code review (22 languages). Run `pi-calldiff --help` for usage details.
requires_bin: pi-calldiff
command: pi-calldiff
---

# pi-calldiff diff

Diff call stacks between two git trees

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `from` | `string` | no | Before ref (default: HEAD) |
| `to` | `string` | no | After ref (default: working tree) |
| `paths` | `array` | no | Limit to these path prefixes |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--entry` | `unknown` |  |  |
| `--maxDepth` | `number` | `12` | Max call-tree depth |
| `--locs` | `boolean` | `false` | Show call-site source locations (file:line) |
| `--from` | `string` |  | Left / "before" tree |
| `--to` | `string` |  | Right / "after" tree |

## Examples

```sh
# HEAD vs working tree
pi-calldiff diff

# One ref vs working tree
pi-calldiff diff main

# Two commits / branches
pi-calldiff diff abc123 def456

# Force entrypoints
pi-calldiff diff main feature --entry createAgentSession
```

> Semantics match git diff: no refs → HEAD vs worktree; one ref → that vs worktree; two refs → compare those trees.

---

# pi-calldiff reach

Find control and optional data paths between two symbols

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `ref` | `string` | no | Git ref (default: working tree) |
| `paths` | `array` | no | Limit to these path prefixes |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--entry` | `unknown` |  | Entrypoint(s): functionName or ClassName.method |
| `--to` | `string` |  | Target symbol to reach (functionName or ClassName.method) |
| `--maxDepth` | `number` | `12` | Max call-tree depth |
| `--locs` | `boolean` | `false` | Show call-site source locations (file:line) |
| `--dataFlow` | `boolean` | `false` | Show JS/TS call arguments → parameters and explicit return expressions |

## Examples

```sh
# Paths in the working tree
pi-calldiff reach --entry runCheckout --to sendEmail

# Paths at a commit, limited to a directory
pi-calldiff reach HEAD examples/checkout --entry runCheckout --to sendEmail
```

> For JavaScript/TypeScript investigations, add --data-flow. Control reachability alone does not show what data crosses each boundary.

---

# pi-calldiff tree

View control flow and optional data in/outflow for entrypoints

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `ref` | `string` | no | Git ref (default: working tree) |
| `paths` | `array` | no | Limit to these path prefixes |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--entry` | `unknown` |  | Entrypoint(s): functionName or ClassName.method |
| `--maxDepth` | `number` | `12` | Max call-tree depth |
| `--locs` | `boolean` | `false` | Show call-site source locations (file:line) |
| `--dataFlow` | `boolean` | `false` | Show JS/TS call arguments → parameters and explicit return expressions |

## Examples

```sh
# Tree from working tree
pi-calldiff tree --entry createAgentSession

# Tree from a commit
pi-calldiff tree HEAD --entry PiService.createAgentSession
```

> For JavaScript/TypeScript investigations, add --data-flow so the graph shows arguments → parameters and returned values → local bindings.
