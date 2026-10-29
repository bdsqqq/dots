# host incident lifecycle

axiom's grouped threshold monitors resolve disappearing series. `notifyEveryRun =
false` does not prevent that resolution/reopening cycle; `alertOnNoData` adds
availability notifications rather than retaining the previous incident.

this evaluator owns the missing state, not host maintenance. it only queries
axiom, writes its sqlite ledger, and emits notification events. no ssh, cleanup,
activation, or restart commands exist in the evaluator.

## notification contract

- a host/mount/condition has one stable incident id until measured recovery.
  critical and warning conditions stay distinct so worsening pressure is visible.
- missing data, query errors, stale samples, and reordered evaluations cannot
  resolve an incident. they reset recovery qualification.
- recovery needs ten minutes of advancing healthy samples and bounded evaluation
  gaps. disk margins prevent threshold-edge chatter: critical 2 → 3 gib,
  headroom 8 → 10 gib, free fraction 10 → 12 percent.
- sleeping laptops do not become availability incidents. successful empty uptime
  queries are failures only for the explicitly monitored always-on hosts.
- oom recovery requires a quiet log window **and** fresh uptime; a dead host is
  not proof that memory pressure stopped.

sqlite commits a transition and its outbox record together. the match monitor
consumes these transition events, not raw metrics. a recovery event carries
`action = Closed`; a match monitor's native `.Action` would incorrectly say
`Open` for that same event. the lifecycle webhook template must use the matched
record's action, ids, and timestamp. hosted email remains axiom's existing
notifier; its match-notification subject can still say “triggered,” while the
record identifies recovery.

## failure boundaries

an ingestion timeout can mean “accepted, response lost.” retrying would duplicate
email. attempts are persisted before submission, then reconciled by event id;
ambiguous attempts are **not automatically resent**. their incident's recovery
waits, but other incidents can proceed. unresolved delivery or backlog older than
fifteen minutes stops healthy heartbeats and trips the independent watchdog.
operator recovery must choose between assuming delivery and explicitly resending
with possible duplication. neither choice happens automatically.

three submissions per minute and two hundred per day conservatively reserve room
for both routes under axiom's match-monitor limits. external notifier delivery
can still be duplicated or reordered; consumers should deduplicate `eventId` and
must not let older measurements override newer state.

an axiom outage also disables its own watchdog. this is not an independent
out-of-band paging system. losing an established database fails closed rather
than silently creating a new incident history.

## handoff

`axiom-incidents probe` is read-only. `init` is an explicit one-time operation:
review and report the currently bad observations it adopts before removing the
old raw monitor routes. never initialize over existing state or use initialization
as a repair. normal `poll` refuses a missing database.

keep old notification routes until the native service, new match monitor, email,
and canonical webhook have been verified. retain both routes on the lifecycle
and evaluator-watchdog monitors. do not publish a cutover that an older native
host configuration will undo on its next upgrade.

runtime code and monitor policy are read from the live checkout; nix owns node,
credentials, the timer, and the private state directory. no dependency install or
host activation is required for ordinary typescript edits.

local replay checks:

```sh
node --experimental-strip-types --test modules/o11y/incidents/*.test.ts
```

wiring changes additionally need native relay evaluation and the consuming
artifact/host checks described in the repository's `AGENTS.md`.
