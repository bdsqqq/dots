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

## external convergence and readiness (opt-in)

`externalExpectations` is optional in the existing runtime JSON. enable only the
always-on mini first; a host must already have a `hosts: telemetry missing` rule
and an entry in `mounts`. inventory alone never opts in a sleeping laptop.
parent integration must add this field to the relay's generated runtime config;
no monitor definition, notification route, database migration or initialization
is required. the lifecycle match monitor already handles these conditions.

```json
{
  "externalExpectations": [{
    "host": "mmn-m4",
    "metricsHost": "mmn-m4.local",
    "enabledAt": "2026-11-07T06:00:00Z",
    "manifestUrl": "http://mmn-m4:5252/manifest.json",
    "services": ["hue", "html-stuff", "files"]
  }]
}
```

replace the example `enabledAt` with the agreed rollout timestamp, fixed across
evaluations; do not regenerate it every poll or rebuild. missing observations
have a 90-minute rollout grace. this gives the first build its full budget before
an absent reporter can alert. measured failures are not hidden by rollout grace.

- upgrade: query the newest `tailnet-registry` / `host.upgrade_health` event per
  normalized host. both its producer `timestamp` and ingestion time must be within
  fifteen minutes. `context.ready` must be boolean, `context.readiness` symbolic,
  and `context.reasonCode` one of the producer's known reasons. only
  `healthy` + `ready=true` can recover. `activation_overdue`, `build_overdue`,
  `attempt_failed`, `convergence_stale`, `partial_dependencies`, `state_missing`
  and `state_invalid` with `ready=false` are failures. `building`, unrecognized
  reasons, inconsistent values and invalid samples are unknown, never recovery.
  the producer owns the 90-minute build budget: this envelope has no build-start
  timestamp, so the relay cannot independently distinguish a perpetual
  `building` classification from a legitimate build. it does detect a stopped
  reporter, but a continuously wrong classifier needs a producer fix.
- readiness: read only the mini's declared `/manifest.json`, not its directory's
  cached fleet view. schema v1, exact `host.name`, `reportedAt`, and per-service
  `health.checkedAt` must be fresh. require the registry's explicit
  `health.reachable`, `health.ready`, `health.readiness` and symbolic
  `health.reasonCode`. `ready=true` also requires `status=up` and reachability.
  legacy `status=up` or HTTP 200 alone is unknown. `ready=false` +
  `readiness=not_ready` is bad EXCEPT the producer's unknown-evidence reasons:
  `readiness_not_configured`, `readiness_unavailable` and `stale_observation`.
  those remain unknown even with boolean `ready=false`; null, stale, missing or
  inconsistent reports are also unknown. valid siblings remain independently
  observable.
- reporter: malformed/unavailable/stale manifests, missing expected services and
  unknown readiness get a separate readiness-reporter condition after grace.
  this indicates missing evidence, not measured app failure. a complete report
  can recover the reporter even when an app is explicitly not ready.

all external observations require uptime evidence no older than two minutes;
an unavailable mini leaves these conditions unknown and its existing host
availability incident owns notification. this avoids blaming apps for host loss.
queries that fail or return partial results stay unknown, not absence. successful
missing upgrade queries become failures only after grace and with fresh uptime.

failures need five minutes of advancing source **and** evaluation evidence;
this avoids paging on ordinary application reloads. repeated samples cannot
qualify. recovery retains the ledger's ten minutes of advancing healthy evidence,
with evaluation gaps bounded to two minutes. unknown resets qualification without
closing an incident. condition/host keys (including the app id in the readiness
condition) retain one incident id across repeated failures until measured recovery.
removing an expectation does not close an existing incident.

HTTP requests are GET-only, have no credentials, reject redirects, cap bodies at
256 kib and enforce a three-second deadline across headers and body. body data,
URLs and arbitrary exceptions are not copied into incidents or operational logs.
the relay needs tailnet access to port 5252 and its existing read/ingest Axiom
permissions. installed `normalized_event*` / `normalized_host` projections must
resolve. before opting in, deploy the registry's explicit readiness extension and
periodic upgrade-health producer, verify the mini's manifest has fresh concrete
readiness for these three ids, then inspect `axiom-incidents probe`. do not run
`init` to add these observations to an established ledger.

this evaluator remains an observer: no SSH, cleanup, activation, restart, or
service-control path is added. Axiom and the relay are still shared failure
boundaries, and a live readiness failure has not been proven by offline replays.

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
