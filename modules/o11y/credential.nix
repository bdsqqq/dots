{ config, lib, hostSystem ? null, ... }:
let
  cfg = config.my.o11y.credential;
  homeDir =
    if lib.hasInfix "darwin" hostSystem then
      "/Users/bdsqqq"
    else
      "/home/bdsqqq";
in
{
  options.my.o11y.credential.required =
    lib.mkEnableOption "the Axiom observability credentials";

  config = lib.mkIf cfg.required {
    sops.secrets = {
      "axiom/personal_url" = {
        sopsFile = ./secrets.yaml;
        key = "personal_url";
        owner = "bdsqqq";
      };
      "axiom/personal_org_id" = {
        sopsFile = ./secrets.yaml;
        key = "personal_org_id";
        owner = "bdsqqq";
      };
      "axiom/personal_token" = {
        sopsFile = ./secrets.yaml;
        key = "personal_token";
        owner = "bdsqqq";
      };
      "axiom/papertrail_token" = {
        sopsFile = ./secrets.yaml;
        key = "papertrail_token";
        owner = "bdsqqq";
      };
      "axiom/host_metrics_token" = {
        sopsFile = ./secrets.yaml;
        key = "host_metrics_token";
        owner = "bdsqqq";
      };
      "axiom.toml" = {
        sopsFile = ./.axiom.toml;
        format = "binary";
        owner = "bdsqqq";
        mode = "0400";
        path = "${homeDir}/.axiom.toml";
      };
    };
  };
}
