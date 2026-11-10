# inference broker

CLIProxyAPI owns routing, account refresh, and its editable native config. Nix owns prerequisites and service wiring; the runner reads this live checkout. account grants and keys stay outside the checkout and Nix store.

## boundaries

- MacBook gateways are local-first: recorder `127.0.0.1:18317`, backend `127.0.0.1:8317`, independent personal login, no published listener. declaration is not enrollment; a gateway with no account cannot infer;
- remote clients can retain home Mac `mmn-m4`, exposed through [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve) at `https://mmn-m4.tail1543a7.ts.net:8317`. there is no automatic fallback from a laptop to this hub;
- each provisioned machine gets a separate client key. the management key is different and remains on the hub. Serve is tailnet-only, but intended owner access still depends on tailnet policy; API authentication remains required;
- direct `claude`, `codex`, and existing Pi providers are unchanged. the named launchers select the broker explicitly;
- Claude subscriptions are for Claude Code here. the Pi broker preset exposes Codex models only. official Agent SDK personal subscription usage is a separate native path, not configured by this module;
- Amp's server-side traffic cannot reach this tailnet-only route. no Amp connection or public ingress is installed;
- session affinity is enabled. upstream round-robin remains the fallback selection strategy; Theo's private soonest-reset scheduler is not implemented.

## account sign-in

use native CLIProxyAPI login **on each gateway**, choosing the personal account:

```sh
inference-broker login codex
```

for the remote hub, run that command over SSH on `mmn-m4`. never copy live OAuth
grants between gateways, or borrow the direct CLI's rotating grant. separate
gateways still share their provider account's quotas.

complete the device flow in your browser. for upstream Codex websockets, enable the credential's `websockets` field through native management (`PATCH /v8/management/credentials/fields`); the client's `supports_websockets` flag alone does not establish an upstream websocket connection. verify the native log's `Upstream Transport` rather than assuming it.

for Claude, its browser callback needs the documented SSH tunnel if your browser is on another machine:

```sh
ssh -L 54545:127.0.0.1:54545 mmn-m4 'inference-broker login claude'
```

account identity is chosen in the browser. repeat intentionally for another account. `inference-broker accounts` on the hub reports provider/status without exporting tokens or account filenames.

native account and configuration details: [Theo's guide](https://gist.github.com/t3dotgg/59a521d2ee8d70aaf90e280c175072af), [upstream config](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.25/config.example.yaml).

## clients and t3

`inference-broker status` checks authenticated model discovery, not inference. it must show models after account enrollment; an empty list is not a working-inference claim.

- `codex-broker …` injects a Responses provider and gateway key for that process; native homes, sessions, direct credentials, and config files stay intact.
- `claude-broker …` injects the gateway endpoint/token for that process. an existing Claude executable wins; otherwise Nix provides the unmodified Claude Code prerequisite.
- Pi: build the package and use `/reload` to load the `inference-broker` provider extension, then choose a `CLIProxyAPI · Codex` model in `/model`. native auth resolves both origin and key from one `inference-broker connection` call at request time; a changed client selection cannot pair a cached remote URL with a new local key. catalog metadata remains in `models.json`. account/model access still needs inference verification.
- t3: add a named **existing CLI** Codex instance with binary path `~/.local/bin/codex-broker`, or a Claude instance with `~/.local/bin/claude-broker`. use absolute expanded paths in settings. do not replace an existing instance or use t3-managed ChatGPT authentication for this route. provider settings belong to the machine executing the harness, not the viewing phone/laptop. these instance additions require the native t3 settings interface; this module does not edit t3's private state.

## private state and enrollment

hub state: `~/.local/share/cli-proxy-api/`, including writable `config.yaml`, `auth/`, `management.key`, per-machine `clients/`, and native logs. seed files are exclusive-create; restarts preserve native YAML/GUI edits. stop and inspect rather than resetting a pre-existing config with missing bootstrap metadata.

client credential: `~/.config/cli-proxy-api/client.json`, directory `0700`, file `0600`. `CLI_PROXY_API_CLIENT_FILE` can select a different explicit connection. do not put its contents in t3 settings or shell arguments.

on the hub, `inference-broker issue-client machine-name` registers a stable per-machine key and prints only its private file path. it waits until the serving path accepts that key. transfer just that file over SSH to the named client's private credential path, never the hub's auth directory or management key. existing client files must be inspected before replacement. revocation is through native management; re-issuing the same machine name deliberately re-registers its retained key.

`inference-broker key` and `inference-broker connection` print secrets for native authentication, NOT diagnostics. never run them in agent/tool logs.

for a fresh local gateway, initialize it with loopback frontend origin
`http://127.0.0.1:18317`, enroll independently, configure upstream capture, and
verify actual local inference before selecting it. `inference-broker use-local
mbp-m2` (or `mbp-m5`) stages/registers a local client, checks backend/frontend
authentication, privately backs up the previous selection, then atomically
replaces it. those checks are discovery, not provider inference. failed staging
preserves the prior selection. reload existing Pi broker sessions first; running
Codex appservers retain their startup endpoint until intentionally restarted.

the panel is `/management.html`. its management key is in the hub's private `management.key`; never paste it in chat. the panel is upstream-downloaded code, not bundled by this module. periodic panel auto-updates are disabled; upstream can still download it on first access.

## lifecycle

`my.cliProxyApi.hub.enable` enables the home-manager user-domain LaunchAgent `dev.cli-proxy-api.broker`. `hub.publish = false` keeps a local gateway off the tailnet registry; the default remains published for the existing hub. published Serve adoption accepts only the declared bootstrap route. account/config files remain editable.

for native edits, reload just this service on the hub:

```sh
launchctl kickstart -k "user/$(id -u)/dev.cli-proxy-api.broker"
```

published runner changes change the Nix wrapper identity so normal host updates reload the service. client wrappers and the daemon execute the same live source. the initial bootstrap may build/root the tools package and install the evaluated plist without activating unrelated pending host changes. remove any manual launchers only when intentionally replacing them with profile-owned equivalents; never discard native config or auth state during an upgrade.

## fleet bootstrap boundary

`fleet.ts` builds from the canonical checkout and leaves credentials/selection
unchanged during tool refresh. `refresh-tools STORE [CODEX_BIN]` updates a stable
private `managed-tools` pointer, migrates recognized owned bootstrap launchers,
and preserves an existing direct Codex pin. differing user files are refused.
normal home activation performs the same refresh, so published source and runtime
source do not diverge behind a stale bootstrap copy. initial bootstrap alone does
not establish automatic host upgrades: verify the executing source, dependency
installation, reload and the machine's existing update path after provisioning.

`t3-presets.ts` adds only `codex_personal_broker`, using the existing CLI wrapper,
and refreshes that instance's pending status. catalog readiness is not an
inference check; defaults and other instances remain unchanged.

## capture is separate

native request logs under the private hub's `auth/logs/` remain best-effort debug output, not the archive. [inference retention](../inference-archive/README.md) adds independent client/upstream journals, a derived ClickHouse index, and encrypted backups. its disk budget does not cap these native debug logs.

only explicitly broker-selected routes are covered. native/direct sessions and other provider upstreams are not implicitly archived. the account-level `websockets` flag alone does not prove upstream capture; the patched Codex recorder route must also be active. see the archive's coverage, failure, and recovery boundaries before enrolling another provider.

## execution-only peering prototype

`my.cliProxyApi.peering.enable` adds a separate user agent,
`dev.cli-proxy-api.peering`, and an authenticated private HTTPS endpoint on
port `18817`. it does not replace the native gateway, change selected clients,
share OAuth files, or expose native management. m2 and mini are the initial
participants; their distinct native grants still share the provider account's
quota. the tailnet policy must allow this port between enrolled participants.

`peering.ts NODE_ID PORT PRIVATE_CONFIG.json` binds only numeric loopback.
Tailscale Serve supplies private TLS. configuration stays outside the store:

```json
{
  "localClientFile": "/absolute/private/local-client.json",
  "callerKeyFile": "/absolute/private/caller.key",
  "incoming": [{ "nodeId": "other-node", "keyFile": "/absolute/private/incoming-other.key" }],
  "peers": [{ "nodeId": "other-node", "clientFile": "/absolute/private/peer-other.json" }]
}
```

paths must be expanded and private. client files use the existing broker
connection format. the local connection must point at a distinct loopback
capture frontend, with a client key registered on that node's native gateway.
peer client files contain only the other peer's HTTPS origin and execution key,
not its management key or upstream grant. incoming keys and the local caller key
must differ. membership changes require reloading only this new agent; key files
are reread for each request.

- `POST /v1/responses` requires the local caller key. discovery checks the local
  gateway first, then enrolled peers. an authenticated local caller may prefer
  one enrolled node using `X-Inference-Prefer-Node`; it cannot supply an arbitrary
  destination URL.
- `POST /peer/v1/responses` requires an incoming peer key and executes **locally
  only**, ignoring routing preferences. cyclic membership cannot add another hop.
- `GET /v1/models` and `/peer/v1/models` use their corresponding credentials and
  report only the local gateway's model catalog. there is no union catalog,
  automatic discovery, quota scheduler, or strict distributed concurrency limit.
- read-only model discovery can skip an unavailable owner. once an inference
  POST is attempted, errors, quota responses, and broken streams are surfaced
  **without replay**. this conservative boundary avoids duplicate execution;
  it does not promise automatic recovery from every failed request.
- HTTP/SSE bodies are passed through without protocol translation. WebSocket
  upgrades return `501`; existing WebSocket-capable broker clients remain on
  their current routes. do not select this prototype as their default.
- the default bounds are eight active requests, a 16 MiB request body, a 2-second
  discovery timeout, and a 5-minute execution deadline. private configuration can
  set `maxConcurrent`, `maxBodyBytes`, `probeTimeoutMs`, and `requestTimeoutMs`.

an executing node still writes through its existing capture frontend. an opaque
correlation UUID links peer events to that node's capture journals; keys, bodies,
and native errors are absent from routing logs. the caller does **not** gain a
second raw journal copy for a remotely executed request. native session files,
receiver journals, asynchronous replication, and backups keep their separate
retention boundaries. local gateways must not themselves be configured to route
back through peer endpoints.

## verification

```sh
(cd modules/cli-proxy-api && pnpm run typecheck && pnpm run test:peering)
node --test modules/cli-proxy-api/broker.test.ts
CLI_PROXY_API_TEST_BINARY=/absolute/path/to/cliproxyapi node --test modules/cli-proxy-api/broker.test.ts
(cd modules/pi && pnpm exec tsc -p ../cli-proxy-api/tsconfig.json)
nix eval --raw --no-write-lock-file '.#darwinConfigurations.mmn-m4.system.drvPath'
nix build --no-link --no-write-lock-file '.#darwinConfigurations.mmn-m4.config.my.cliProxyApi.toolsPackage'
```

the opt-in native test exercises the actual binary's config load/save, auth activation, and rejected unauthenticated access without provider accounts or inference. unit fixtures also reject unsafe credentials and redirects. account/model inference, tool calls, and websockets remain separate acceptance checks after enrollment.
