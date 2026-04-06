{ lib, inputs, hostSystem ? null, config ? {}, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  homeDir = if isDarwin then "/Users/bdsqqq" else "/home/bdsqqq";
  repoPi = "${homeDir}/commonplace/01_files/nix/user/pi";
  # repo path for mkOutOfStoreSymlink — edits take effect immediately without rebuild
  repoExtensions = "${homeDir}/commonplace/01_files/nix/user/pi/packages/extensions";
  repoAgentPrompts = "${homeDir}/commonplace/01_files/nix/user/agents/agents";
in
{
  sops.templates."pi-auth.json" = {
    content = builtins.toJSON {
      openrouter = { type = "api_key"; key = config.sops.placeholder.open_router; };
      opencode = { type = "api_key"; key = config.sops.placeholder.opencode_zen; };
      "openai-codex" = {
      type = "oauth";
      access = config.sops.placeholder.openai_codex_access;
      refresh = config.sops.placeholder.openai_codex_refresh;
      expires = config.sops.placeholder.openai_codex_expires;
      accountId = config.sops.placeholder.openai_codex_accountId; };
    };
    owner = "bdsqqq";
    mode = "0600";
  };

  home-manager.users.bdsqqq = { pkgs, config, lib, ... }: {
    home.file.".pi/agent/auth.json".source = config.lib.file.mkOutOfStoreSymlink "/run/secrets/rendered/pi-auth.json";
    home.file.".pi/agent/settings.json".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/user/pi/settings.json";
    home.file.".pi/agent/tool-policy.json".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/user/pi/tool-policy.json";
    home.file.".pi/agent/keybindings.json".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/user/pi/keybindings.json";

    # extensions — single directory symlink, pi scans subdirectories for package.json with pi.extensions
    home.file.".pi/agent/extensions".source = config.lib.file.mkOutOfStoreSymlink "${repoExtensions}";

    # pi wrapper — run under bun instead of node for workspace resolution.
    # pi's jiti extension loader creates require() scoped to the SYMLINK path
    # (~/.pi/agent/extensions/...), not the realpath (repo/extensions/...).
    # under node, jiti transpiles TS → CJS but fails in ESM context.
    # under bun, jiti uses tryNative mode (native import) which resolves
    # @bds_pi/* workspace packages via bun's native workspace support.
    #
    # overwrites ~/.bun/bin/pi (the node-shebang symlink created by bun install)
    # with a wrapper script. no PATH ordering needed — same location, just runs
    # bun instead of node. pi 0.62 still ships a bun-specific cli entrypoint; prefer
    # that when present because running bun against dist/cli.js regressed custom
    # extension loading (`exports is not defined in ES module scope`). keep the
    # legacy dist/cli.js path as fallback for older installs.
    #
    # CRITICAL: the wrapper exports PI_BIN pointing to itself. pi-spawn and
    # other sub-agent spawners must use $PI_BIN instead of "pi" to ensure
    # child processes use the bun CLI, not the node_modules/.bin/pi symlink
    # (which points to the Node.js CLI and fails with ES module extensions).
    home.activation.piBunWrapper = lib.hm.dag.entryAfter [ "installPiExtensionDeps" ] ''
      PI_WRAPPER="${homeDir}/.bun/bin/pi"
      PI_BUN_CLI="${homeDir}/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/bun/cli.js"
      PI_LEGACY_CLI="${homeDir}/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/cli.js"
      if [ -e "$PI_BUN_CLI" ]; then
        PI_CLI="$PI_BUN_CLI"
      else
        PI_CLI="$PI_LEGACY_CLI"
      fi
      if [ -e "$PI_CLI" ]; then
        rm -f "$PI_WRAPPER"
        printf '%s\n' '#!/usr/bin/env bash' "export NODE_PATH=\"${repoPi}/node_modules\"" "export PI_BIN=\"$PI_WRAPPER\"" "exec bun \"$PI_CLI\" \"\$@\"" > "$PI_WRAPPER"
        chmod +x "$PI_WRAPPER"
      fi
    '';

    # install workspace deps declaratively for all extension packages
    home.activation.installPiExtensionDeps = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      if [ -f "${repoPi}/package.json" ]; then
        "${pkgs.bun}/bin/bun" install --cwd "${repoPi}" --frozen-lockfile 2>/dev/null \
          || "${pkgs.bun}/bin/bun" install --cwd "${repoPi}" || true
      fi
    '';

    # handoff skill — teaches the agent about context management via handoff
    home.file.".pi/agent/skills/handoff/SKILL.md".source = ./skills/handoff/SKILL.md;

    # agent definitions — shared plaintext prompt files from the repo
    home.file.".pi/agent/agents".source = config.lib.file.mkOutOfStoreSymlink "${repoAgentPrompts}";
  };
}
