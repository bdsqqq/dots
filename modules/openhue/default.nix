{ config, lib, ... }:
let
  cfg = config.my.openhue.integration;
  source = "${config.my.paths.commonplace}/01_files/nix/modules/openhue/ready.ts";
in
{
  options.my.openhue.integration = {
    enable = lib.mkEnableOption "selected paired Hue bridge integration";
    bridge = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Exact intended bridge address in the private native config.";
    };
    configHome = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Private XDG_CONFIG_HOME containing openhue/config.yaml.";
    };
    nativeConfigFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Explicit declaration of configHome/openhue/config.yaml; pairing key stays native/private.";
    };
  };
  config = {
    assertions = [
      {
        assertion =
          !cfg.enable
          || (
            cfg.bridge != null
            && cfg.bridge != ""
            && cfg.configHome != null
            && lib.hasPrefix "/" cfg.configHome
            && !(lib.hasPrefix "/nix/store/" cfg.configHome)
            && cfg.nativeConfigFile == "${cfg.configHome}/openhue/config.yaml"
          );
        message = "openhue integration requires bridge, private absolute configHome and nativeConfigFile; physical pairing remains explicit";
      }
    ];
    home-manager.users.bdsqqq = { pkgs, ... }: {
      home.packages = [
        pkgs.openhue-cli
        (pkgs.writeShellScriptBin "openhue-ready" ''
          exec ${pkgs.nodejs}/bin/node --experimental-strip-types ${lib.escapeShellArg source} ${
            lib.escapeShellArgs [
              "${pkgs.openhue-cli}/bin/openhue"
              "${pkgs.yq-go}/bin/yq"
              (if cfg.enable then "1" else "0")
              (if cfg.configHome == null then "" else cfg.configHome)
              (if cfg.bridge == null then "" else cfg.bridge)
            ]
          } "$@"
        '')
      ];
    };
  };
}
