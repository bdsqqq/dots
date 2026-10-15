{ config, lib, ... }:
let cfg = config.my.gog.credential;
in {
  options.my.gog.credential = {
    required = lib.mkEnableOption "the gog static OAuth client credential";
    passwordRequired = lib.mkEnableOption "the gog file-keyring password";
    sopsFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = if builtins.pathExists ./secrets.yaml then ./secrets.yaml else null;
      description = "Encrypted owner file containing gog_oauth_client and, for file keyrings, gog_keyring_password.";
    };
  };
  config = lib.mkMerge [
    { assertions = [{
      assertion = !(cfg.required || cfg.passwordRequired) || (cfg.sopsFile != null && builtins.pathExists cfg.sopsFile);
      message = "gog auth requires my.gog.credential.sopsFile; provision the owning encrypted credentials first.";
    }]; }
    (lib.mkIf (cfg.required && cfg.sopsFile != null) {
      sops.secrets.gog_oauth_client = { inherit (cfg) sopsFile; owner = "bdsqqq"; mode = "0400"; };
    })
    (lib.mkIf (cfg.passwordRequired && cfg.sopsFile != null) {
      sops.secrets.gog_keyring_password = { inherit (cfg) sopsFile; owner = "bdsqqq"; mode = "0400"; };
    })
  ];
}
