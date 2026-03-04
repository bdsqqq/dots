{ lib, inputs, hostSystem ? null, config ? {}, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  homeDir = if isDarwin then "/Users/bdsqqq" else "/home/bdsqqq";
  repoPi = "${homeDir}/commonplace/01_files/nix/user/pi";
  # repo path for mkOutOfStoreSymlink — edits take effect immediately without rebuild
  repoExtensions = "${homeDir}/commonplace/01_files/nix/user/pi/packages/extensions";
in
{
  sops.templates."pi-auth.json" = {
    content = builtins.toJSON {
      openrouter = { type = "api_key"; key = config.sops.placeholder.open_router; };
      opencode = { type = "api_key"; key = config.sops.placeholder.opencode_zen; };
    };
    owner = "bdsqqq";
    mode = "0600";
  };

  home-manager.users.bdsqqq = { pkgs, config, lib, ... }: {
    home.file.".pi/agent/auth.json".source = config.lib.file.mkOutOfStoreSymlink "/run/secrets/rendered/pi-auth.json";
    home.file.".pi/agent/settings.json".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/user/pi/settings.json";
    home.file.".pi/agent/permissions.json".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/user/pi/permissions.json";
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
    # bun instead of node. re-applied on every activation in case bun install
    # regenerates the symlink.
    home.activation.piBunWrapper = lib.hm.dag.entryAfter [ "installPiExtensionDeps" ] ''
      PI_WRAPPER="${homeDir}/.bun/bin/pi"
      PI_CLI="${homeDir}/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/cli.js"
      if [ -e "$PI_CLI" ]; then
        rm -f "$PI_WRAPPER"
        printf '%s\n' '#!/usr/bin/env bash' "exec bun \"$PI_CLI\" \"\$@\"" > "$PI_WRAPPER"
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

    # agent definitions — point to decrypted prompts in ~/.config/agents/prompts
    home.file.".pi/agent/agents".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.config/agents/prompts";
  };
}
