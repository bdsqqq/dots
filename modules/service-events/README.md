# service operation events

operational logs need to explain an operation without reconstructing several
unrelated lines. `events.ts` supplies the completion envelope; each service owns
which operations matter and which bounded metadata explains its outcome.

`begin(operation, traffic, context).finish(outcome, context)` emits once, even if
both completion and abort callbacks fire. IDs originate on the server, durations
use a monotonic clock, and the timestamp records completion. A returned event
means instrumentation ran, **not** that a collector or remote dataset accepted it.
The default stdout transport is best-effort and does not change application
outcomes if its sink fails.

## privacy and interpretation

- use stable route categories, not paths, query strings, filenames, document
  contents, device identifiers, account details, headers, or arbitrary errors.
- context has an allowlist of primitive fields and bounded symbolic strings.
  callers still must choose safe values; this is not general-purpose redaction.
- use `safeErrorCode` for exceptions. useful domain failures should also carry a
  stable `reasonCode`; raw exception messages can contain private paths or data.
- `browser` means browser-like user agent, not a verified person, unique visitor,
  or session. `probe`, `background`, and `unknown` remain separate categories.
- a successful HTTP response can coexist with degraded application readiness.
  record both without silently changing the service's API or alert policy.
- emit significant-operation summaries and state transitions rather than a line
  at every internal call. third-party process output is not automatically part
  of this contract.

## collection boundary

existing host/container journal and launchd-file collection transports stdout.
`../o11y/papertrail-virtual-fields.json` extracts the same envelope from direct
JSON or a JSON event nested inside journald `MESSAGE`, while retaining legacy
records. Event IDs support deduplication after transport retries.

event projections are additive. Existing `normalized_service`,
`normalized_operation`, and `normalized_severity` retain their legacy semantics;
use `normalized_event_service`, `normalized_event_operation`, and
`normalized_event_severity` for completion events, or coalesce each event field
with its legacy counterpart. Updating the shared fields to depend on the new
decoder failed in live Axiom queries; preserving them keeps existing consumers
working.

publishing these virtual-field definitions, deploying new packaged services,
changing health aggregation, and enabling notifications are separate operations.
none happens by running the tests below. Structured readiness events alone do
not fix Bluetooth hardware/permission failures or add missing service alerts.

once the projections are installed, a usage-oriented query can filter
`normalized_traffic == 'browser'`, group by `normalized_event_service` and
`normalized_context.route`, and deduplicate `normalized_event_id`. That counts
request completions—not people. Repetitive polls/retries may be summarized;
use `normalized_context.observationCount` when present rather than treating
one summary row as one request. Health checks and background work must not be
presented as usage.

## verification

from the repository root:

```sh
node --experimental-strip-types --test modules/service-events/*.test.ts
node --experimental-strip-types --test modules/cloudflare-ingress/origin-check.test.ts modules/o11y/incidents/*.test.ts
```

`checks.service-events` runs the offline contract, projection-dependency,
origin-check, incident, file-browser, gallery, and indexer tests in a Nix build. The projection test deliberately
removes its envelope dependency to verify that a broken field definition fails.
Leaf services exercise their emitted records alongside their existing behavior
suites. Package builds are also necessary: source-only tests cannot detect a
relative import omitted from the Nix store closure. `packaging.test.ts` accepts
`HTML_STUFF_BINARY`, `MONEY_PORTAL_BINARY`, `FILES_BROWSER_BINARY`,
`PHOTO_GALLERY_BINARY`, `PHOTO_INTELLIGENCE_BINARY`, and `TAILNET_REGISTRY_BINARY`
to exercise built executables with isolated fixture data. For the Hue app bundle,
set `HUE_CONTROL_BINARY` to its Node executable and `HUE_CONTROL_SCRIPT` to the
bundled daemon entrypoint. Checks are skipped when their binary path is absent.

An optional read-only Axiom test evaluates synthetic direct, journald-wrapped,
legacy and invalid-event fixtures against the actual APL expressions. It needs a
query-capable deployment and at least one source row in the last hour:

```sh
SERVICE_EVENTS_AXIOM_DEPLOYMENT=personal node --experimental-strip-types --test modules/service-events/projections.test.ts
```

this does not ingest fixture events or update virtual fields. After publishing,
add `SERVICE_EVENTS_AXIOM_VERIFY_INSTALLED=1` to verify that the actual installed
fields resolve by name. That check also confirms that an absent field is rejected;
fixture evaluation alone does not validate installed virtual-field resolution.
