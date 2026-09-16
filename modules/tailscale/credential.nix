{ config, lib, ... }:
let
  cfg = config.my.tailscale.credential;
in
{
  options.my.tailscale.credential.required =
    lib.mkEnableOption "the shared Tailscale enrollment credential";

  config = lib.mkIf cfg.required {
    sops.secrets.tailscale_auth_key = {
      sopsFile = ./secrets.yaml;
      owner = "bdsqqq";
      mode = "0400";
    };
  };
}
