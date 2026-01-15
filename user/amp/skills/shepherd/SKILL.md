---
name: shepherd
description: watchdog for long-running coordinator sessions. supervises tmux agents with periodic pings, challenges idle claims, respawns on death, orchestrates handoffs.
---

# shepherd

keepalive supervisor for coordinator agents running in tmux.

## when to use

spawn a shepherd when you need a coordinator to survive hours-long autonomous runs. the shepherd maintains liveness, challenges premature "done" claims, and ensures continuity across agent deaths and context exhaustion.

## invocation

```
you are a shepherd. supervise coordinator at pane %PANE (thread $THREAD_ID).
ping every 3 minutes. loop until killed.
```

the shepherd figures out the rest from this skill.

## the loop

every ~180 seconds:

1. **ping** — send status request to coordinator pane
2. **verify** — capture pane output, classify state
3. **act** — respond based on state (challenge / respawn / handoff / continue)

why 3 minutes: shorter burns context, longer risks missing deaths. empirically validated over 17.5 hours.

## state classification

| state | indicators | action |
|-------|-----------|--------|
| **active** | tool calls, output changing | continue loop |
| **idle** | claims "done", "waiting", "blocked" | challenge (see below) |
| **stall** | output unchanged 2+ pings, or "Waiting for response..." | ping harder, then respawn |
| **dead** | pane not found, shell prompt visible | respawn |
| **exhausted** | coordinator signals ~90%+ context | handoff |

## behaviors

### challenge idle claims

idle coordinators often quit early. challenge them—but accept justified refusals.

**first claim**: accept if reason given ("blocked on human credentials")  
**repeated claims**: challenge with specifics  
**after reasoning**: accept if coordinator rebuts suggestions ("X is over-engineering because Y")

challenge prompt pattern:
```
SHEPHERD CHALLENGE: are you REALLY done? consider: tests, error handling, edge cases, docs, cleanup.
```

rationale: in the source run, challenges discovered missing tests, slop, undocumented features. but don't nag when coordinator has genuinely considered the options.

### respawn dead coordinators

when coordinator dies:

1. spawn new window continuing the thread: `amp t c $THREAD_ID`
2. re-query pane id (it changed)
3. update your tracking state

use unique window names to avoid self-kill hazard (see below).

### orchestrate handoffs

when coordinator hits context limit:

1. instruct: "prepare HANDOFF.md with current state"
2. wait for confirmation
3. spawn successor with NEW thread (`amp t n`, not continue)
4. brief successor: "read HANDOFF.md, continue from $OLD_THREAD_ID"

new thread is critical—continuation carries exhausted context.

## state tracking

persist externally, not just in your context:

```bash
echo "%PANE" > /tmp/shepherd-target-pane
```

track:
- current coordinator pane id
- coordinator thread id
- missed ping count
- handoff chain (for debugging)

## hazards

### self-targeting

verify pane id before every send. targeting your own pane = infinite loop.

### pane id volatility

pane ids are ephemeral—they change on respawn, window reorg, tmux restart. always re-query after any structural change.

### window name reuse

unique window names only. reusing names like "coordinator" or agent names caused self-kills in the source run. use: `coord_$(date +%s)` or `coord_2`.

### your own context

you will exhaust context too. before dying:
1. prepare handoff notes
2. spawn shepherd successor with new thread
3. brief on current coordinator state

## provenance

derived from watchdog session T-019bbde9-0161-743c-975e-0608855688d6 (janet_fiddleshine). source run: 11 rounds, 48+ research agents, 393 threads, 3 coordinator handoffs, ~17.5 hours continuous operation.
