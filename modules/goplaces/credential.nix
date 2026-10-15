{ config, lib, ... }:
let cfg = config.my.goplaces.credential;
in {
  options.my.goplaces.credential = {
    required = lib.mkEnableOption "the Google Places API credential";
    sopsFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = if builtins.pathExists ./secrets.yaml then ./secrets.yaml else null;
      description = "Encrypted owner file containing google_places_api_key.";
    };
  };
  config = lib.mkMerge [
    { assertions = [{
      assertion = !cfg.required || (cfg.sopsFile != null && builtins.pathExists cfg.sopsFile);
      message = "Places auth requires my.goplaces.credential.sopsFile or an intentionally externally provisioned my.goplaces.apiKeyFile.";
    }]; }
    (lib.mkIf (cfg.required && cfg.sopsFile != null) {
      sops.secrets.google_places_api_key = { inherit (cfg) sopsFile; owner = "bdsqqq"; mode = "0400"; };
    })
  ];
}
