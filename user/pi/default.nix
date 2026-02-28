{ lib, inputs, hostSystem ? null, config ? {}, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  homeDir = if isDarwin then "/Users/bdsqqq" else "/home/bdsqqq";
  repoPi = "${homeDir}/commonplace/01_files/nix/user/pi";
  # repo path for mkOutOfStoreSymlink — edits take effect immediately without rebuild
  repoExtensions = "${homeDir}/commonplace/01_files/nix/user/pi/extensions";
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

    # extensions — symlinked to repo working tree so edits are instant (no rebuild needed)
    home.file.".pi/agent/extensions/editor".source = config.lib.file.mkOutOfStoreSymlink "${repoExtensions}/editor";
    home.file.".pi/agent/extensions/handoff.ts".source = config.lib.file.mkOutOfStoreSymlink "${repoExtensions}/handoff.ts";
    home.file.".pi/agent/extensions/session-name.ts".source = config.lib.file.mkOutOfStoreSymlink "${repoExtensions}/session-name.ts";
    home.file.".pi/agent/extensions/tool-harness.ts".source = config.lib.file.mkOutOfStoreSymlink "${repoExtensions}/tool-harness.ts";
    home.file.".pi/agent/extensions/system-prompt.ts".source = config.lib.file.mkOutOfStoreSymlink "${repoExtensions}/system-prompt.ts";
    home.file.".pi/agent/extensions/command-palette".source = config.lib.file.mkOutOfStoreSymlink "${repoExtensions}/command-palette";
    home.file.".pi/agent/extensions/tools".source = config.lib.file.mkOutOfStoreSymlink "${repoExtensions}/tools";
    home.file.".pi/agent/extensions/mermaid".source = config.lib.file.mkOutOfStoreSymlink "${repoExtensions}/mermaid";

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
