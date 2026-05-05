{ lib, pkgs, hostSystem ? null, ... }:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  flakePath =
    if isDarwin then
      "/Users/bdsqqq/commonplace/01_files/nix"
    else
      "/home/bdsqqq/commonplace/01_files/nix";
in
if isDarwin then {
  environment.systemPackages = [ pkgs.nh ];
  environment.variables.NH_FLAKE = flakePath;
} else {
  programs.nh = {
    enable = true;
    flake = flakePath;
  };
}
