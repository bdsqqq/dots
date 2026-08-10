# calldiff

> This is the private `@bds_pi/calldiff` fork of Tanishq Kancharla's calldiff
> 0.4.1. It preserves the upstream 22-language implementation and adds explicit
> callback-contract edges for Pi extensions and Promise executors. In this
> workspace, invoke it as `pi-calldiff`.

Diff call stacks across git commits — like `git diff`, but for who-calls-whom.

Built for **agentic code review**: when an agent (or you) rewires call flow, plain line diffs bury the shape of the change. `calldiff` shows which callees appeared, disappeared, or moved under an entrypoint — across **22 languages**.

```diff
  PiService.createAgentSession(options)
- ├─ AuthStorage.create()
- ├─ new ModelRegistry
- ├─ createCodingTools()
+ ├─ PiService.getServices()
+ │  ├─ SettingsManager.create()
+ │  ├─ AuthStorage.create()
+ │  └─ new ModelRegistry
```

## Local usage

Home Manager builds this workspace package and exposes its fork-specific binary:

```console
pi-calldiff --help
```

## Usage

```bash
# HEAD vs working tree
pi-calldiff diff

# one ref vs working tree
pi-calldiff diff main

# two commits / branches
pi-calldiff diff abc123 def456
pi-calldiff diff --from main --to feature

# force entrypoints (functionName or ClassName.method)
pi-calldiff diff main feature --entry createAgentSession
pi-calldiff diff main feature -e PiService.createAgentSession -e boot

# limit to paths (trailing positionals; leading -- also accepted)
pi-calldiff diff main feature src/lib

# view a call tree (no diff) — requires --entry
pi-calldiff tree -e createAgentSession
pi-calldiff tree HEAD -e PiService.createAgentSession
pi-calldiff tree main -e boot --max-depth 8 src/lib
pi-calldiff tree -e runCheckout --locs examples/checkout

# find all call paths from one symbol to another — requires --entry and --to
pi-calldiff reach -e runCheckout --to sendEmail
pi-calldiff reach HEAD -e runCheckout --to sendEmail examples/checkout

# agent / machine-readable output (via incur)
pi-calldiff diff --format json
pi-calldiff --llms
```

### `diff` semantics (git-diff shaped)

| Invocation                  | From     | To           |
| --------------------------- | -------- | ------------ |
| `calldiff diff`             | `HEAD`   | working tree |
| `calldiff diff <from>`      | `<from>` | working tree |
| `calldiff diff <from> <to>` | `<from>` | `<to>`       |

`-` lines were present in **from** and gone in **to**.
`+` lines are new in **to**.

If you omit `--entry`, calldiff infers exported functions whose expanded call trees changed (and may show several).

### `tree`

| Invocation                      | Tree from       |
| ------------------------------- | --------------- |
| `calldiff tree -e <name>`       | working tree    |
| `calldiff tree <ref> -e <name>` | that commit/ref |

Prints a plain ASCII call tree (no `+/−` markers). `--entry` / `-e` is required.
With `--locs`, each node shows a source location: the root uses the definition
`file:line`, and children use the **call site** in the parent (`file:line` or
`file:line-line`) — same idea as LSP Call Hierarchy `fromRanges`, not Go to
Definition.

### `reach`

| Invocation                                     | Paths from      |
| ---------------------------------------------- | --------------- |
| `calldiff reach -e <from> --to <target>`       | working tree    |
| `calldiff reach <ref> -e <from> --to <target>` | that commit/ref |

Prints every call path from the entrypoint to the target (including alternate `if` / `else` arms). Both `--entry` / `-e` and `--to` are required.

### Labels

- `functionName` — free function
- `ClassName.method` — class method
- `new ClassName` — constructor / `new` call
- `Component` — JSX/TSX component tags (`<Button />`); children nest under the parent
- `if (cond)` / `else` / `else if (cond)` — conditional arms (no continuing `│` rail)
- `file:line` — call-site (or root definition) location; enable with `--locs` (default off)

### Supported languages

TypeScript, TSX, JavaScript, JSX, Python, Go, Rust, Java, Ruby, C, C++, C#, PHP, Kotlin, Swift, Scala, Lua, Elixir, Bash, Haskell, Zig, Solidity, OCaml.

## Output

- **Default:** colored ASCII callstack trees (TTY) / colorless ASCII when piped — same shape as before.
- **`--format json|yaml|md|jsonl`:** structured result (`from`/`to`/`trees` or `paths` with nested nodes + per-entry `ascii`) for agents and scripts.
- Built on [incur](https://github.com/wevm/incur): `skills add`, `mcp add`, `--llms`, CTAs after diffs, typed flags.

## How it works

1. Reads source from both git trees (`git show` / working tree)
2. Detects language by file extension, loads a [tree-sitter](https://tree-sitter.github.io/tree-sitter/) grammar (bundled or on-demand into `~/.cache/calldiff/grammars`), and parses
3. Builds per-function callee lists and expands them into call trees
4. Diffs the trees, prints a tree, or searches paths — plus structured output for agents

Grammars install on first use (override cache with `CALLDIFF_GRAMMAR_CACHE`). This is syntactic (AST-based), not a full typechecker — dynamic calls won’t resolve.

## Dev

```bash
npm run dev -- diff main HEAD --entry PiService.createAgentSession
npm run dev -- tree -e runCheckout -- examples/checkout
npm run dev -- reach -e runCheckout --to sendEmail -- examples/checkout
```
