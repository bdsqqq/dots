{ config, lib, ... }:
let
  cfg = config.my.github.credential;
in
{
  options.my.github.credential.required =
    lib.mkEnableOption "the GitHub API credential";

  config = lib.mkIf cfg.required {
    sops.secrets.gh_token = {
      sopsFile = ./secrets.yaml;
      owner = "bdsqqq";
      mode = "0400";
    };
  };
}
