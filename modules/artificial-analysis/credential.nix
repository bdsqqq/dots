{ config, lib, ... }:
let
  cfg = config.my.artificialAnalysis.credential;
in
{
  options.my.artificialAnalysis.credential.required =
    lib.mkEnableOption "the Artificial Analysis API credential";

  config = lib.mkIf cfg.required {
    sops.secrets.artificial_analysis_api_key = {
      sopsFile = ./secrets.yaml;
      owner = "bdsqqq";
      mode = "0400";
    };
  };
}
