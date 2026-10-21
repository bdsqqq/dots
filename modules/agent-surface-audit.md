# existing agent surfaces and inline settings

working-tree survey, 2026-10-14, reconciled with main `f7e2f8c5` and pending
CLI entrypoint links. these are source findings, not a runtime
inventory or a request to migrate every module. new CLI skills are covered by
the [module pattern](README.md).

## useful capabilities without dedicated guidance

**VERIFIED (traced):** the sources below declare commands or services. no dedicated
entrypoint for these capabilities was found in the shared skill collection;
REA's Pi-native path is separate. the replay below is a countercheck for this
bounded absence finding, not proof about every installed agent. **HUNCH:** guidance may help
when platform, data freshness, privacy, or multi-step operation matters.

- **transcription:** [darwin-transcription/default.nix:19](darwin-transcription/default.nix#L19)
  defines an Apple Silicon pipeline, private model/state directories, speaker
  profiles, and working outputs. guidance could distinguish transcription from
  speaker identification and explain evidence limits.
- **browser tabs:** [helium/remotes.nix:298](helium/remotes.nix#L298)
  exposes `helium-tabs` and its publisher service. guidance could distinguish
  searching synced tab manifests from inspecting a live browser.
- **nearby Hue bulbs:** [hue-control/default.nix:55](hue-control/default.nix#L55)
  installs the BLE client/daemon; [its service wiring](hue-control/default.nix#L43)
  exposes health and host-local enrollment. this is not OpenHue's LAN bridge
  integration. guidance should choose between them rather than conflate them.
- **household intake:** [household-intake/package.nix:3](household-intake/package.nix#L3)
  exposes `household-intake-smb-audit`. guidance could bound access to SMB sources
  and explain what an audit establishes before moving or deleting anything.
- **photo intelligence:** [photo-intelligence/service.nix:15](photo-intelligence/service.nix#L15)
  starts a source/index service; [the benchmark package](photo-intelligence/benchmark/default.nix#L13)
  exposes `photo-semantic-benchmark`. these are service and evaluation surfaces,
  not proof of a usable photo-search CLI. trace the API before writing a skill.
- **media acquisition:** [yt-dlp/default.nix:6](yt-dlp/default.nix#L6)
  wires cookies, a package override, and subtitle preferences. a workflow could
  connect authorized acquisition with transcription while retaining source
  and language limitations. [gallery-dl](gallery-dl/default.nix) is also installed.
- **offline documentation:** [wikiman/default.nix:67](wikiman/default.nix#L67)
  installs Wikiman and an updating ArchWiki snapshot. guidance could explain
  offline search and snapshot freshness.
- **Node-based tools:** [node-pnpm/package.json](node-pnpm/package.json)
  includes `agent-browser`, `parallel-web-cli`, and `vercel`. no dedicated
  entrypoint for those tools was found. inspect installed commands and existing
  retrieval/browser workflows before adding narrowly scoped guidance.

these commands may already be callable through an agent's shell. a skill is
worth adding when it changes a recurring decision, not merely to advertise
every executable on `PATH`. ordinary `rg`, `jq`, and `fd` use does not need
one skill per tool.

Linear and Hunk already have vendored [Linear](agents/skills/linear/SKILL.md)
and [Hunk](agents/skills/hunk-review/SKILL.md) entrypoints.
[Git](agents/skills/git/SKILL.md),
[company money](agents/skills/company-money/SKILL.md), and Axiom have shared guidance.
REA stays with its installed release via [Pi's native skills path](pi/settings.json#L8);
there is no shared REA owner. Axiom's
[skill](agents/skills/using-axiom/SKILL.md) focuses on MCP access; CLI coverage
still needs assessment against actual tasks.

## settings still expressed inline

**VERIFIED (traced) source occurrences; not yet migrated:**

- [mise/default.nix:9](mise/default.nix#L9): native `config.toml` generated
  from an inline string. the Node version is also used by activation at
  [line 27](mise/default.nix#L27); moving settings must preserve one source
  for that install contract.
- [node-pnpm/default.nix:60](node-pnpm/default.nix#L60): QMD's `index.yml`
  inline. collection paths depend on the host's home directory.
- [git/default.nix:50](git/default.nix#L50): Git preferences inline,
  mixed with generated credential-helper and executable paths. split ordinary
  preferences from required wiring before proposing a native writable file.
- [tmux/default.nix:475](tmux/default.nix#L475): plugin and main
  `extraConfig` strings, including Nix-derived commands.
- [niri/home.nix:261](niri/home.nix#L261): typed compositor settings;
  additional raw KDL and dconf settings are in the same module.
  [niri/default.nix:75](niri/default.nix#L75) also generates the terminal
  file-chooser config. these need a separate consumption-path review.
- [backup/default.nix:88](backup/default.nix#L88): Nix generates the complete
  Backrest policy. [home activation](backup/default.nix#L251) stops the daemon,
  installs a mode-0600 temporary file, then atomically replaces writable
  `config.json` at [line 310](backup/default.nix#L310). it does not merge UI edits.
  [daemon startup](backup/default.nix#L94) reuses that file and separate history
  data; UI policy edits survive ordinary restarts but are replaced at activation.
  this current policy boundary departs from the all-module editable-file target;
  this survey does not authorize changing it.

Wikiman and yt-dlp's easy preference files have now been extracted into
[wikiman.conf](wikiman/wikiman.conf) and [yt-dlp/config](yt-dlp/config),
with out-of-store links. Wikiman's generated source adapter remains executable
wiring. mise and QMD still need their path/version dependencies traced; this
survey does not migrate the remaining preferences.

SSH, Nix, Bluetooth, Tailscale policy, launchd/systemd units, Cloudflare ingress,
and tailnet registry also contain inline or generated configuration.
these occurrences need consumer-specific classification: service wiring remains
declarative; ordinary native preferences follow the all-module editable-file
contract. an infrastructure label alone does not exempt editable preferences.

[Ghostty](ghostty/default.nix#L19), [btop](btop/default.nix#L12), and
[VSCodium](vscodium/default.nix#L11) already link separate live settings. Obsidian
already has a separate desktop profile; preserve its seeding and mutable state.

## replay and limits

from the repository root:

```sh
rg --files modules -g '*.nix' -g '!**/node_modules/**'
rg -n 'home\.packages|environment\.systemPackages|writeShellApplication|writeShellScriptBin' \
  modules -g '*.nix' -g '!**/node_modules/**'
rg -n 'settings\s*=|\.text\s*=|extraConfig\s*=|builtins\.toJSON' \
  modules -g '*.nix' -g '!**/node_modules/**'
find modules/agents/skills -name SKILL.md -print
rg -n 'skills|mkOutOfStoreSymlink' modules/agents/default.nix
rg -n 'rea-agents/skills' modules/pi/settings.json
rg -n -i 'transcri|helium|hue-control|household-intake|photo-intelligence|yt-dlp|gallery-dl|wikiman|agent-browser|parallel-web|vercel' \
  modules/agents/skills -g SKILL.md
ls -l modules/agents/skills/{gog,wacli,goplaces,openhue,xurl,weather,remindctl,obsidian}/SKILL.md
rg -n 'settings =|backupConfig|install -m 0600|mv -f|config-file|data-dir' \
  modules/backup/default.nix
```

inspect each match's consumer. these searches find syntactic occurrences, not
every indirect configuration generated by Home Manager. absence of an exact
tool name in a skill is not proof that a broader workflow never uses it.
host imports, activation, authentication, and actual runtime access were not
established by this survey.
