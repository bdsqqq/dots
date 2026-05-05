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
    real="${pkgs.nh}/bin/nh"
    case "''${1:-}" in
      os|darwin|home|clean|search|-*|--*|"") exec "$real" "$@" ;;
      *) exec "$real" "${systemSubject}" "$@" ;;
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
