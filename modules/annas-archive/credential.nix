{ config, lib, ... }:
let
  cfg = config.my.annasArchive.credential;
in
{
  options.my.annasArchive.credential = {
    required = lib.mkEnableOption "the Anna's Archive account credential";
    sopsFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = if builtins.pathExists ./secrets.yaml then ./secrets.yaml else null;
      description = "Encrypted owner file containing annas_archive_key.";
    };
  };

  config = lib.mkIf cfg.required {
    assertions = [
      {
        assertion = cfg.sopsFile != null && builtins.pathExists cfg.sopsFile;
        message = "Anna's Archive requires my.annasArchive.credential.sopsFile or an intentionally provisioned my.annasArchive.apiKeyFile; no credential is fabricated.";
      }
    ];
    sops.secrets.annas_archive_key = lib.mkIf (cfg.sopsFile != null) {
      inherit (cfg) sopsFile;
      owner = "bdsqqq";
      mode = "0400";
    };
  };
}
