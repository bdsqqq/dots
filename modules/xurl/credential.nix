{ config, lib, ... }:
let
  cfg = config.my.xurl.credential;
in
{
  options.my.xurl.credential = {
    required = lib.mkEnableOption "static X OAuth app credential owner (not refreshable native tokens)";
    sopsFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = if builtins.pathExists ./secrets.yaml then ./secrets.yaml else null;
      description = "Encrypted owner file containing xurl_app: private JSON client_id/client_secret.";
    };
  };
  config = lib.mkIf cfg.required {
    assertions = [
      {
        assertion = cfg.sopsFile != null;
        message = "xurl credential owner requires an encrypted sopsFile; none is fabricated";
      }
    ];
    sops.secrets.xurl_app = lib.mkIf (cfg.sopsFile != null) {
      inherit (cfg) sopsFile;
      owner = "bdsqqq";
      mode = "0400";
    };
  };
}
