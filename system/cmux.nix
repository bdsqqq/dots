{ lib, pkgs, hostSystem ? null, ... }:

if !(lib.hasInfix "darwin" hostSystem) then
  { }
else
  let
    cmuxCli = pkgs.runCommand "cmux-cli" { } ''
      mkdir -p "$out/bin"
      ln -s "/Applications/cmux.app/Contents/Resources/bin/cmux" "$out/bin/cmux"
    '';
  in
  {
    environment.systemPackages = [ cmuxCli ];

    homebrew = {
      taps = [ "manaflow-ai/cmux" ];
      casks = [ "cmux" ];
    };
  }
