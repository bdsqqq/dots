---
name: spar
description: adversarial review via spawned antithesis agent. use for code review, debugging, or any analysis where false positives must be pruned.
---

# spar

adversarial debate protocol. spawns an antithesis agent to challenge your findings. catches false positives and surfaces missed issues.

**load first:** `review` — provides epistemic standards for both agents.
**prerequisite skills:** `spawn`, `coordinate`, `report`

assumes prerequisite skills are sibling directories (spawn, coordinate, report alongside spar).

## when to load

- reviewing code, designs, or documentation
- debugging findings that need second opinion
- any analysis where you'll report findings to others
- when "first clean" can't be trusted

## protocol

```
1. produce initial review with confidence labels (VERIFIED/HUNCH/QUESTION)
2. spawn antithesis agent with challenge instructions
3. iterate thesis/antithesis/synthesis rounds:
   - antithesis: challenge strongest/most confident claim
   - thesis: verify claim, concede or defend with evidence
   - synthesis: update position, identify next target
4. terminate after 2+ consecutive rounds with no position change
```

## spawning antithesis

```bash
ANTITHESIS=$(../spawn/scripts/spawn-amp "ANTITHESIS — challenge thesis findings.

your role: refute, challenge, find weaknesses. attack VERIFIED claims first (they claim highest confidence). load the review skill. read the source material independently.

findings to challenge:
<paste findings here>

files to examine:
<file list>

communicate via: tmux send-keys -t <coordinator-pane> 'AGENT \$NAME: <message>' C-m

wait for synthesis before next challenge. take turns.")
```

## communication

use tmux send-keys directly. slash commands are unreliable over tmux.

antithesis → coordinator:
```bash
tmux send-keys -t %5 'AGENT $NAME: <challenge or concession>' C-m
```

coordinator → antithesis:
```bash
tmux send-keys -t $ANTITHESIS 'THESIS: <defense or concession>' C-m
```

## synthesis

after each exchange, update your position:

```markdown
## synthesis round N

**challenged:** <which claim>
**verdict:** UPHELD | REFUTED | MODIFIED
**position update:** <revised finding if modified, or "no change">
**next target:** <which claim antithesis should challenge next, or "none — stable">
```

## termination

stable when 2+ consecutive rounds produce no position changes.

final output:

```markdown
## spar result

| round | challenged | verdict |
|-------|------------|---------|
| 1 | race condition claim | MODIFIED |
| 2 | auth bypass claim | REFUTED |
| 3 | input validation | UPHELD |
| 4 | (stability check) | no change |
| 5 | (stability check) | no change |

### revised findings
<updated findings with verdicts>

### pruned claims
<claims that were refuted, with reasoning>
```

## meta-auditor phase

dialectic can produce manufactured findings — agents invent problems to appear rigorous.

after spar claims completion, audit for authenticity:

```markdown
## meta-audit

for each finding from spar:

| finding | trace to source? | would skill fail without? | box-checking risk | verdict |
|---------|-----------------|---------------------------|-------------------|---------|
| add slop example | yes — traces to confident-ai research | yes — epistemic skills show failure modes | LOW | GENUINE |
| rename pattern section | no source | no functional impact | HIGH | MANUFACTURED |

**recommendation:** KEEP genuine findings, REVERT manufactured ones.
```

spawn a separate meta-auditor agent if context is long:

```bash
META=$(../spawn/scripts/spawn-amp "META-AUDITOR — audit spar findings for authenticity.

assume MANUFACTURED until proven. for each finding:
1. does it trace to specific research? (cite source)
2. would the artifact ACTUALLY fail without this change?
3. box-checking risk: LOW/MODERATE/HIGH

verdict: GENUINE or MANUFACTURED
recommendation: KEEP or REVERT

findings to audit:
<paste spar results>")
```

## composition with rounds

spar can be orchestrated by rounds for parallel debates:

```
rounds (orchestrator)
├── court 1: spar(finding A)
│   ├── thesis agent
│   └── antithesis agent
├── court 2: spar(finding B)
│   ├── thesis agent
│   └── antithesis agent
└── court 3: spar(finding C)
    ├── thesis agent
    └── antithesis agent

→ rounds collects verdicts
→ runs meta-auditor on all verdicts
→ iterates if issues found
```

interface contract for rounds:
- **input:** claim/finding to debate + relevant file paths
- **output:** verdict (UPHELD/REFUTED/MODIFIED) + revised finding if modified
- **termination:** 2+ synthesis rounds with no position change

## pitfalls

- **premature convergence:** agents agree too fast to satisfy "2 clean rounds." skepticism is the cure.
- **manufactured issues:** antithesis invents challenges to have something to say. meta-auditor catches these.
- **slash commands:** unreliable over tmux. use direct send-keys.
- **permission prompts:** require arrow keys + enter. ask user to handle manually.
