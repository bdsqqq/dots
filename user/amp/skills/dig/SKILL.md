---
name: dig
description: systematic investigation and debugging methodology. hypothesis-driven analysis with verification agents. use for incident response, codebase archaeology, dependency mapping, root cause analysis, or any investigation requiring verified findings.
---

# dig

structured approach to investigations that produces verified, actionable findings.

## core principles

1. **trust code over assumptions** — never assume intent. check git history.
2. **scripts > docs** — extraction scales, documentation doesn't.
3. **bidirectional analysis** — traverse dependencies forward AND reverse.
4. **verify claims** — spawn verification agents to fact-check analysis agents.
5. **label hunches explicitly** — `hunch (unverified)` vs facts with evidence.
6. **autonomous discovery** — use seeds and graph traversal, don't hardcode.

## investigation phases

### phase 1: map

scope the problem. identify seeds (entry points) for traversal.

```
1. define the question precisely
2. identify seed artifacts (files, functions, types, API endpoints)
3. choose traversal strategy:
   - reverse: seed → importers → consumers (finds affected scope)
   - forward: seed → dependencies → leaves (finds implementation details)
   - bidirectional: both (complete picture)
4. extract, don't document — write scripts that produce structured output
```

when to check git:
- `git blame <file>` — who wrote this line? when? why?
- `git log -p --follow -- <file>` — full history of a file
- `git log --all --oneline -- <path>` — find when something was introduced
- `git log --grep="<term>"` — find commits mentioning a concept

### phase 2: verify

spawn verification agents to fact-check analysis claims.

```
for each major claim:
  1. spawn a verification agent with ONLY the claim + file paths
  2. agent must independently confirm or refute
  3. record: VERIFIED, REFUTED, or INCONCLUSIVE
```

verification agent prompt template:
```
verify this claim: "<claim>"
files to check: <file list>
do not assume the claim is correct.
check the actual code and report what you find.
```

anti-patterns:
- trusting oracle/LLM statements without code verification
- assuming wrapper names without grep confirmation
- documenting before extracting

### phase 3: synthesize

structure findings for consumption.

**tables** for enumeration:
| location | code | effect |
|----------|------|--------|

**trees** for relationships:
```
RootComponent
├── ChildA → uses Feature
└── ChildB
    └── GrandchildC → also uses Feature
```

**appendices** for exhaustive lists (don't clutter main findings).

## output structure

```markdown
# <investigation title>

## summary
one paragraph. what did we find?

## context
why are we investigating? link to trigger (slack, ticket, etc.)

## findings
### 1. <finding title>
<evidence with file links>
<code snippets>

### 2. <finding title>
...

## open questions
numbered list of things we couldn't verify

## appendices
- [detailed-list-a.md](./detailed-list-a.md)
- [detailed-list-b.md](./detailed-list-b.md)

## related threads
table of amp thread links with descriptions
```

## verification agent pattern

when coordinating investigation:

```
1. spawn analysis agents (stores, routes, components, etc.)
   - each produces claims with file:line citations
   
2. collect claims from all analysis agents

3. spawn verification agents (1 per analysis agent)
   - input: claims + file paths only
   - output: VERIFIED/REFUTED/INCONCLUSIVE for each claim
   
4. synthesizer combines verified claims into report
```

this catches:
- oracle hallucinations
- outdated information
- claims about files that changed since analysis started

## autonomous discovery

never hardcode component lists. instead:

```bash
# start from seeds
SEEDS=$(grep -rl "import.*from.*deprecated-lib" --include="*.ts")

# build import graph
for seed in $SEEDS; do
  # find importers (reverse)
  grep -rl "import.*from.*$seed" --include="*.ts"
  
  # find imports (forward)  
  grep "^import" "$seed" | extract_paths
done
```

bidirectional traversal discovers components you didn't know existed.

## when to use

- production incident with unclear root cause
- "how does this feature actually work?"
- dependency upgrade impact assessment
- "why was this designed this way?" (git archaeology)
- mapping blast radius of a refactor

## references

- [AXM-10608-investigation-report.md](references/AXM-10608-investigation-report.md) — multi-dataset assumption mapping
- [2025-10-22T21:50-process-summary.md](references/2025-10-22T21:50-process-summary.md) — rc-menu dependency discovery evolution
