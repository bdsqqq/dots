{ config, lib, ... }:
let
  cfg = config.my.parallelWebSearch.credential;
in
{
  options.my.parallelWebSearch.credential.required =
    lib.mkEnableOption "the Parallel web search API credential";

  config = lib.mkIf cfg.required {
    sops.secrets.parallel_api_key = {
      sopsFile = ./secrets.yaml;
      owner = "bdsqqq";
      mode = "0400";
    };
  };
}
