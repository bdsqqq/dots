# agent setup direction

use T3 to work with agents. use this repository to give those agents useful
tools, provision credentials, and run the services those tools require.
keep working data in `commonplace`. build only what the existing pieces lack.

this is the agreed direction, not a claim that the tools or automations below
are installed, authenticated, or working.

## what we want

send several requests, leave agents working, and return to useful results.
those results might be a code change, an investigation, a room plan, a purchase
comparison, or something that needs a decision. a passing test or completed
thread is evidence about execution, not necessarily a useful outcome.

agents should also initiate useful work from events and recurring assignments.
they need access to relevant current and past work, room to collaborate, and a
way to bring back results without reporting every uneventful check.

responsibilities can overlap. do not impose a coordinator/worker/reviewer
roster or assign one agent to each connector.

## who owns what

### T3: interaction and execution

T3 owns threads, continuity, delegation, workspaces, and the supported automation
and notification mechanisms. use those before inventing replacements.

Codex is one provider among several. preserve the configured work and personal
instances; do not treat one provider or account as the universal execution layer.
each run must select an appropriate provider and execution environment.

`t3.json` is project configuration, not a complete declaration of T3.
it can carry workspace defaults and project actions. provider configuration,
automation registrations, and thread state have separate native management.
app overrides can take precedence over file defaults; imported actions are not
necessarily continuously synchronized with their source.

keep reusable assignment briefs and operational scripts in files. let T3 retain
execution history and native state. do not build another continuity database.

### `nix`: fleet provisioning

this repository owns CLI availability on each host's `PATH`, credential wiring,
and service lifecycle. it can be an operations workspace without becoming every
process's mandatory working directory.

use Nix for prerequisites, wiring, and services. keep native configuration
editable across all modules; migrate existing departures in scoped changes.
preserve native updates and unpublished edits. propagation
must include installation and reload/apply, not just an updated checkout.

use the existing [SOPS ownership model](SECRETS.md) for persistent credentials:
encrypted files have a stable owner, and consumers receive only what they need.
keep plaintext out of Git, generated artifacts, logs, and the Nix store.

central management does not mean every host gets every account's credentials.
OAuth renewal and linked-device state need tool-specific lifecycle handling;
activation must not repeatedly overwrite newer mutable state with an old copy.

### `commonplace`: working data

documents, vaults, inputs, and useful outputs belong in the relevant working
data locations. treat access as host-specific. a synced copy is not proof of
current state or access to a live application.

separating `commonplace` from the repository's parent directory is a separate,
user-owned move. this direction does not authorize it.

## tools first

keep each CLI's declaration, local skill, and optional native settings together,
following the [editable module pattern](modules/README.md). this applies to all
modules, not only CLIs. link editable settings to
the actual file the program reads and writes. keep private native authorization
state outside tracked settings and preserve refreshed state.

the eight selected CLI skills stay beside their modules, with relative
`SKILL.md` links in `modules/agents/skills/<cli>/`. the agent module links that
shared collection to the supported local discovery aliases. host imports select
packages separately; shared discovery proves neither installation nor account
access. REA remains Pi-native through its installed release's skills path.

prefer an adequate existing CLI. agents can use it across harnesses through
their shell tools, without duplicating native tool registration.

choose tools by their actual contracts: noninteractive operation, structured
output, explicit account selection, scoped access, useful errors, and supported
platforms. installation alone does not establish any of these in our environment.

### immediate access

- **email and calendar:** evaluate `gog` for the requested Gmail and Calendar
  access. investigate the previous Google setup before replacing authorization.
  authorize only the services and access needed; start with reads.
- **WhatsApp:** evaluate `wacli` for linked-device sync and local message search.
  history coverage is best-effort, and the integration uses an unofficial
  protocol implementation. measure available coverage rather than promising a
  complete archive. keep its session and message store private.

do not install a bulk skill collection to obtain a binary. skills are optional
guidance, not a prerequisite for giving agents tool access.

### optional capabilities

OpenClaw's skills are a source of tool choices and operational examples, not a
bundle to import wholesale. candidates include:

- `remindctl`: Apple Reminders, on an authorized Mac.
- `goplaces`: place search and details, with Google Places API access.
- Obsidian: direct vault files for ordinary document work; the official CLI for
  app-aware operations, which require a running Obsidian instance.
- `openhue`: lights and scenes from a host that can reach the paired Hue bridge.
- `xurl`: X API access under the selected application's account and permissions.
- weather: existing HTTP tools may suffice; no dedicated service by default.

`mcporter` is deferred. we currently have no selected MCP-only capability that
needs a CLI interface. consider it only when such a requirement appears; do not
install it or configure servers merely to complete a tooling stack.

read Hermes and OpenClaw integration code for authentication, sync, event
handling, and recovery patterns before writing equivalents. a messaging channel
for talking to an agent is not automatically searchable access to a personal
mailbox or message history.

adapt selected guidance to our tools and policies. keep deterministic operations
in tested code, and conditional workflow decisions in skills. new scripts and
services use TypeScript, not JavaScript-only prototypes.

## turn access into recurring work

tools provide capabilities. triggers initiate work. standing briefs describe
what useful progress looks like and when to involve the user.

use native T3 schedules and webhook triggers where supported. poll a source
when it has no suitable event interface. add a custom receiver only for a
demonstrated gap such as event translation, verification, or routing.

receiver code belongs beside its setup; a service manager owns its process.
placing code in a working folder neither starts it nor exposes an endpoint.
external webhook senders need reachable ingress and verified requests.

keep source cursors, duplicate suppression, and explicit failure handling close
to the integration that needs them. that bookkeeping is not another agent
identity or continuity system.

notify for a useful result, a consequential question, or lost coverage.
keep unchanged scans quiet and group nonurgent findings. ordinary agent
communication must not require a human inbox-approval ceremony.

## host and authority boundaries

`htz-xfs-lab` is the candidate for work that must continue while the Mac sleeps.
reuse its existing setup and preserve its storage and running services.
`htz-relay` is not the proactive-agent host.

Mac-only capabilities stay on a Mac. home-network capabilities stay where the
required network is reachable. an offline host means unavailable live access,
not permission to substitute a stale snapshot silently.

provision capability and authorize action separately. read access does not
authorize sending messages, publishing, deleting, or changing accounts.
policy and tool filtering are not an OS sandbox; neither is a working folder.

## how we make progress

deliver coherent slices without reducing the destination to a convenient demo:

1. establish email/calendar and WhatsApp access without skill pollution.
2. connect useful standing assignments to native triggers and attention paths.
3. add optional capabilities when an actual task benefits from them.

the implementing agent owns integration and verification. the user supplies
architectural opinions and reviews useful outcomes, not an engineering test plan.
browser consent or linked-device pairing may still require the account owner.

a capability is ready when the selected T3 provider can use it on the intended
host, with the intended account, without interactive prompts during ordinary
runs. check restart behavior, private-state preservation, failure reporting,
and credential renewal where applicable.

an automation is ready when a real trigger produces useful work, that work
reaches the intended review surface, and continuation uses the existing thread
and prior work. prove remote work while the Mac is offline where that matters.
test denied actions separately before claiming enforced restrictions.

ship the result, use it, and address observed gaps. do not substitute a storage
prototype, installation report, or architecture diagram for working access.

## references

- [T3 project schema](https://t3.codes/schema/t3.json).
- [`gog`](https://github.com/openclaw/gogcli),
  [`gws`](https://github.com/googleworkspace/cli), and
  [`wacli`](https://github.com/openclaw/wacli).
- [`mcporter`](https://github.com/openclaw/mcporter).
- [OpenClaw skills](https://github.com/openclaw/openclaw/tree/main/skills) and
  [Hermes](https://github.com/NousResearch/hermes-agent).
- Linear's [product direction](https://linear.app/method/product-direction) and
  [small project scopes](https://linear.app/method/scope-projects) inform the
  delivery approach, not a prescribed implementation order or timeline.

upstream references establish documented behavior and prior art. installed
versions, account access, and end-to-end delivery require our own checks.
