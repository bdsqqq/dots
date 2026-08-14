{ lib, pkgs, hostSystem ? null, ... }:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  flakePath =
    if isDarwin then
      "/Users/bdsqqq/commonplace/01_files/nix"
    else
      "/home/bdsqqq/commonplace/01_files/nix";
  systemSubject = if isDarwin then "darwin" else "os";
  nhWrapped = pkgs.writeShellScriptBin "nh" ''
    set -o pipefail

    real="${pkgs.nh}/bin/nh"
    log_dir="${if isDarwin then "$HOME/Library/Logs/nh" else "$HOME/.local/state/nh/logs"}"

    case "''${1:-}" in
      os|darwin|home|clean|search)
        args=("$@")
        ;;
      -*|--*|"")
        exec "$real" "$@"
        ;;
      *)
        args=("${systemSubject}" "$@")
        ;;
    esac

    subject="''${args[0]:-}"
    action="''${args[1]:-}"
    case "$action" in
      switch|boot|test|build)
        mkdir -p "$log_dir"
        timestamp="$(${pkgs.coreutils}/bin/date -u +%Y%m%dT%H%M%SZ)"
        log_file="$log_dir/$timestamp-$subject-$action.log"
        "$real" "''${args[@]}" 2>&1 | ${pkgs.coreutils}/bin/tee "$log_file"
        exit ''${PIPESTATUS[0]}
        ;;
      *)
        exec "$real" "''${args[@]}"
        ;;
    esac
  '';
in
if isDarwin then {
  environment.systemPackages = [ nhWrapped ];
  environment.variables.NH_FLAKE = flakePath;
} else {
  programs.nh = {
    enable = true;
    package = nhWrapped;
    flake = flakePath;
  };
}
