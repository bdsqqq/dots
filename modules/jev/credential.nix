{ config, lib, ... }:
let
  cfg = config.my.jev.credential;
in
{
  options.my.jev.credential = {
    required = lib.mkEnableOption "the Jev API credential";
    sopsFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = if builtins.pathExists ./secrets.yaml then ./secrets.yaml else null;
      description = "Encrypted owner file containing jev_api_key.";
    };
  };

  config = lib.mkIf cfg.required {
    assertions = [
      {
        assertion = cfg.sopsFile != null;
        message = "Jev requires an encrypted my.jev.credential.sopsFile; create modules/jev/secrets.yaml with sops first.";
      }
    ];
    sops.secrets.jev_api_key = lib.mkIf (cfg.sopsFile != null) {
      inherit (cfg) sopsFile;
      owner = "bdsqqq";
      mode = "0400";
    };
  };
}
