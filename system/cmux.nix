{ lib, pkgs, hostSystem ? null, ... }:

if !(lib.hasInfix "darwin" hostSystem) then
  { }
else
  let
    cmuxConfig = pkgs.writeText "cmux.json" (builtins.readFile ./cmux.json);
    cmuxFleetSource = pkgs.writeText "cmux-fleet.sh" (builtins.readFile ./cmux-fleet.sh);
    cmuxCli = pkgs.runCommand "cmux-cli" { } ''
      mkdir -p "$out/bin"
      ln -s "/Applications/cmux.app/Contents/Resources/bin/cmux" "$out/bin/cmux"
    '';
    cmuxFleet = pkgs.writeShellApplication {
      name = "cmux-fleet";
      runtimeInputs = [
        cmuxCli
        pkgs.jq
      ];
      text = ''
        export CMUX_FLEET_CONFIG=${lib.escapeShellArg cmuxConfig}
        exec ${pkgs.bash}/bin/bash ${cmuxFleetSource} "$@"
      '';
    };
  in
  {
    environment.systemPackages = [
      cmuxCli
      cmuxFleet
    ];

    homebrew = {
      taps = [ "manaflow-ai/cmux" ];
      casks = [ "cmux" ];
    };

    home-manager.users.bdsqqq.home.file.".config/cmux/cmux.json".source = cmuxConfig;
  }
