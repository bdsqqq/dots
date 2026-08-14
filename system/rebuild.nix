{
  config,
  lib,
  pkgs,
  ...
}:

let
  hostName = config.networking.hostName;
  # the syncthing mirror excludes .git, so its worktree cannot reliably represent main.
  rebuild = pkgs.writeShellScriptBin "rebuild" ''
    set -o pipefail

    case "''${1:-}" in
      switch|boot|test|build)
        action="$1"
        shift
        ;;
      *)
        action="switch"
        ;;
    esac

    log_dir="$HOME/.local/state/rebuild/logs"
    mkdir -p "$log_dir"
    timestamp="$(${pkgs.coreutils}/bin/date -u +%Y%m%dT%H%M%SZ)"
    log_file="$log_dir/$timestamp-$action.log"

    ${pkgs.sudo}/bin/sudo \
      ${config.system.build.nixos-rebuild}/bin/nixos-rebuild \
      "$action" \
      --flake ${lib.escapeShellArg "github:bdsqqq/dots#${hostName}"} \
      --refresh \
      "$@" 2>&1 | ${pkgs.coreutils}/bin/tee "$log_file"
    exit ''${PIPESTATUS[0]}
  '';
in
{
  environment.systemPackages = [ rebuild ];
}
