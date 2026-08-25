{ config, lib, pkgs, hostSystem ? null, ... }:

if !(lib.hasInfix "darwin" hostSystem) then
  { }
else
  let
    cmuxConfig = "${config.my.paths.commonplace}/01_files/nix/modules/cmux/cmux.json";
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
      taps = [{
        name = "manaflow-ai/cmux";
        trusted = true;
      }];
      casks = [ "cmux" ];
    };

    home-manager.users.bdsqqq = { config, ... }: {
      home.file.".config/cmux/cmux.json" = {
        source = config.lib.file.mkOutOfStoreSymlink cmuxConfig;
        force = true;
      };
    };
  }
