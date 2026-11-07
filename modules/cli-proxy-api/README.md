# inference broker

CLIProxyAPI owns routing, account refresh, and its editable native config. Nix owns prerequisites and service wiring; the runner reads this live checkout. account grants and keys stay outside the checkout and Nix store.

## boundaries

- the hub is the home Mac `mmn-m4`, loopback `127.0.0.1:8317`, exposed through [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve) at `https://mmn-m4.tail1543a7.ts.net:8317`;
- each provisioned machine gets a separate client key. the management key is different and remains on the hub. Serve is tailnet-only, but intended owner access still depends on tailnet policy; API authentication remains required;
- direct `claude`, `codex`, and existing Pi providers are unchanged. the named launchers select the broker explicitly;
- Claude subscriptions are for Claude Code here. the Pi broker preset exposes Codex models only. official Agent SDK personal subscription usage is a separate native path, not configured by this module;
- Amp's server-side traffic cannot reach this tailnet-only route. no Amp connection or public ingress is installed;
- session affinity is enabled. upstream round-robin remains the fallback selection strategy; Theo's private soonest-reset scheduler is not implemented.

## account sign-in

on the hub, use its native CLIProxyAPI login flow; do not copy a laptop's live OAuth grant or refresh-token files:

```sh
ssh mmn-m4 'inference-broker login codex'
```

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
- Pi: open `/model` to reload `modules/pi/models.json`, then choose a `CLIProxyAPI · Codex` model. catalog capability metadata comes from the pinned Pi Codex catalog; actual account/model access still needs an inference test.
- t3: add a named **existing CLI** Codex instance with binary path `~/.local/bin/codex-broker`, or a Claude instance with `~/.local/bin/claude-broker`. use absolute expanded paths in settings. do not replace an existing instance or use t3-managed ChatGPT authentication for this route. provider settings belong to the machine executing the harness, not the viewing phone/laptop. these instance additions require the native t3 settings interface; this module does not edit t3's private state.

## private state and enrollment

hub state: `~/.local/share/cli-proxy-api/`, including writable `config.yaml`, `auth/`, `management.key`, per-machine `clients/`, and native logs. seed files are exclusive-create; restarts preserve native YAML/GUI edits. stop and inspect rather than resetting a pre-existing config with missing bootstrap metadata.

client credential: `~/.config/cli-proxy-api/client.json`, directory `0700`, file `0600`. `CLI_PROXY_API_CLIENT_FILE` can select a different explicit connection. do not put its contents in t3 settings or shell arguments.

on the hub, `inference-broker issue-client machine-name` registers a stable per-machine key and prints only its private file path. it waits until the serving path accepts that key. transfer just that file over SSH to the named client's private credential path, never the hub's auth directory or management key. existing client files must be inspected before replacement. revocation is through native management; re-issuing the same machine name deliberately re-registers its retained key.

`inference-broker key` is a credential-command interface for Pi, NOT a diagnostic: it prints a secret. never run it in agent/tool logs.

the panel is `/management.html`. its management key is in the hub's private `management.key`; never paste it in chat. the panel is upstream-downloaded code, not bundled by this module. periodic panel auto-updates are disabled; upstream can still download it on first access.

## lifecycle

`my.cliProxyApi.hub.enable` enables the home-manager user-domain LaunchAgent `dev.cli-proxy-api.broker`. the hub's existing auto-login keeps the user environment available. Serve wiring is declared in the tailnet registry; `adoptExisting` accepts only the exact bootstrap route.

for native edits, reload just this service on the hub:

```sh
launchctl kickstart -k "user/$(id -u)/dev.cli-proxy-api.broker"
```

published runner changes change the Nix wrapper identity so normal host updates reload the service. client wrappers and the daemon execute the same live source. the initial bootstrap may build/root the tools package and install the evaluated plist without activating unrelated pending host changes. remove any manual launchers only when intentionally replacing them with profile-owned equivalents; never discard native config or auth state during an upgrade.

## fleet bootstrap boundary

`fleet.ts` provisions per-machine credentials and editable, versioned bootstrap
copies without overwriting existing native files. these isolated Linux bootstrap
sources are not yet a verified canonical-checkout/automatic-upgrade handoff.
changing a bootstrap source changes its launcher target; a differing existing
launcher is intentionally rejected, not silently replaced. do not advertise
these provisional clients as automatically converging with published updates.

`t3-presets.ts` adds only `codex_personal_broker`, using the existing CLI wrapper,
and refreshes that instance's pending status. catalog readiness is not an
inference check; defaults and other instances remain unchanged.

## capture is separate

native request logs under the private hub's `auth/logs/` remain best-effort debug output, not the archive. [inference retention](../inference-archive/README.md) adds independent client/upstream journals, a derived ClickHouse index, and encrypted backups. its disk budget does not cap these native debug logs.

only explicitly broker-selected routes are covered. native/direct sessions and other provider upstreams are not implicitly archived. the account-level `websockets` flag alone does not prove upstream capture; the patched Codex recorder route must also be active. see the archive's coverage, failure, and recovery boundaries before enrolling another provider.

## verification

```sh
node --test modules/cli-proxy-api/broker.test.ts
CLI_PROXY_API_TEST_BINARY=/absolute/path/to/cliproxyapi node --test modules/cli-proxy-api/broker.test.ts
(cd modules/pi && pnpm exec tsc -p ../cli-proxy-api/tsconfig.json)
nix eval --raw --no-write-lock-file '.#darwinConfigurations.mmn-m4.system.drvPath'
nix build --no-link --no-write-lock-file '.#darwinConfigurations.mmn-m4.config.my.cliProxyApi.toolsPackage'
```

the opt-in native test exercises the actual binary's config load/save, auth activation, and rejected unauthenticated access without provider accounts or inference. unit fixtures also reject unsafe credentials and redirects. account/model inference, tool calls, and websockets remain separate acceptance checks after enrollment.
