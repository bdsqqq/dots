---
name: shepherd
description: "watchdog for autonomous runs that will exhaust context and need handoffs. supervises tmux agents, respawns on death, orchestrates handoffs. NOT for single-session tasks."
---

# shepherd

keepalive supervisor for coordinator agents.

## when to use

spawn a shepherd when you need a coordinator to survive across context exhaustion and agent deaths. the shepherd maintains liveness, challenges premature "done" claims, and ensures continuity via handoffs.

## when NOT to use

before spawning a shepherd, ask:

1. **will this exhaust context?** shepherd is for runs needing handoffs. if task fits in one session, don't add supervision.
2. **do i have explicit termination criteria?** shepherd keeps things alive. without exit conditions, it runs forever.
3. **is this already overengineered?** shepherd → coordinator → rounds → spar → agents is a Rube Goldberg machine. simplify first.

shepherd is for runs that will EXHAUST CONTEXT. don't use it to add ceremony to single-session work.

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

why 3 minutes: shorter burns context, longer risks missing deaths. tested over 17.5 hours in source run.

## state classification

| state | indicators | action |
|-------|-----------|--------|
| **active** | tool calls, output changing | continue loop |
| **idle** | claims "done", "waiting", "blocked" | challenge (see below) |
| **stall** | output unchanged 2+ pings, or "Waiting for response..." | send Enter key to unstick, then respawn if no response |
| **dead** | pane not found, shell prompt visible | respawn |
| **exhausted** | coordinator signals ~90%+ context | handoff |

## behaviors

### challenge idle claims

coordinators quit early. challenge them—but accept justified refusals.

**first claim**: accept if reasoned ("blocked on human credentials")  
**repeated claim**: challenge with specifics  
**third claim**: accept if rebutted ("X is over-engineering because Y")

challenge prompt pattern:
```
SHEPHERD CHALLENGE: are you REALLY done? consider: tests, error handling, edge cases, docs, cleanup.
```

rationale: in source run T-019bbde9-0161-743c-975e-0608855688d6, challenges discovered missing tests, slop, undocumented features. but don't nag when coordinator has genuinely considered the options.

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

persist all state externally (context resets lose variables):

```bash
# initialize
echo "%PANE" > /tmp/shepherd-target-pane
echo "$THREAD_ID" > /tmp/shepherd-thread-id
echo "0" > /tmp/shepherd-missed-pings
echo "" > /tmp/shepherd-handoff-chain

# read before each ping
PANE=$(cat /tmp/shepherd-target-pane)
THREAD=$(cat /tmp/shepherd-thread-id)
MISSED=$(cat /tmp/shepherd-missed-pings)

# update after events
echo "$NEW_PANE" > /tmp/shepherd-target-pane
echo "$((MISSED + 1))" > /tmp/shepherd-missed-pings
echo "$THREAD -> $NEW_THREAD" >> /tmp/shepherd-handoff-chain
```

track:
- current coordinator pane id
- coordinator thread id
- missed ping count
- handoff chain (for debugging)

## hazards

### pane id hazards

pane ids are ephemeral—they change on respawn, window reorg, tmux restart. verify pane id before every send; targeting your own pane = infinite loop. always re-query after any structural change.

### window name reuse

unique window names only. reusing names like "coordinator" or agent names caused self-kills in the source run. use: `coord_$(date +%s)` or `coord_2`.

### your own context

you will exhaust context too. follow the handoff process above for yourself.

## provenance

derived from watchdog session T-019bbde9-0161-743c-975e-0608855688d6 (janet_fiddleshine). source run: 11 rounds, 48+ research agents, 393 threads, 3 coordinator handoffs, ~17.5 hours continuous operation.
