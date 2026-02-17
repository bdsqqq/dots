{ lib, inputs, hostSystem ? null, config ? {}, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  homeDir = if isDarwin then "/Users/bdsqqq" else "/home/bdsqqq";
  # local fork at ~/www/pi-mono — build with `npm run build` from repo root
  # temporary: remove once upstream ships the --tools extension filter fix
  piMonoRoot = "${homeDir}/www/pi-mono";
  piCliPath = "${piMonoRoot}/packages/coding-agent/dist/cli.js";
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

  home-manager.users.bdsqqq = { pkgs, config, lib, ... }: let
    # wrapper that runs the fork's cli.js with the monorepo's node_modules
    pi-fork = pkgs.writeShellScriptBin "pi" ''
      exec ${pkgs.nodejs_22}/bin/node "${piCliPath}" "$@"
    '';
  in {
    home.file.".pi/agent/auth.json".source = config.lib.file.mkOutOfStoreSymlink "/run/secrets/rendered/pi-auth.json";
    home.file.".pi/agent/settings.json".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/user/pi/settings.json";

    # subagent extension — single file, agents discovered from ~/.pi/agent/agents at runtime
    home.file.".pi/agent/extensions/sub-agents.ts".source = ./extensions/sub-agents.ts;

    # agent definitions (point to existing prompts folder)
    home.file.".pi/agent/agents".source = ../agents/prompts;

    # fork wrapper — order 90 wins over pnpm (100)
    custom.path.segments = [
      { order = 90; value = "${pi-fork}/bin"; }
    ];
  };
}
