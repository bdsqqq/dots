{ config, lib, hostSystem ? null, ... }:
let
  cfg = config.my.cloudflare.credential;
  homeDir =
    if lib.hasInfix "darwin" hostSystem then
      "/Users/bdsqqq"
    else
      "/home/bdsqqq";
in
{
  options.my.cloudflare.credential.required =
    lib.mkEnableOption "the Cloudflare account certificate";

  config = lib.mkIf cfg.required {
    sops.secrets.cloudflare_cert_pem = {
      sopsFile = ./secrets.yaml;
      owner = "bdsqqq";
      mode = "0400";
      path = "${homeDir}/.cloudflared/cert.pem";
    };
  };
}
