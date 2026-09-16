{ config, lib, ... }:
let
  cfg = config.my.mediaCookies.credential;
in
{
  options.my.mediaCookies.credential.required =
    lib.mkEnableOption "the media downloader cookie jar";

  config = lib.mkIf cfg.required {
    sops.secrets.cookies = {
      sopsFile = ./cookies.txt;
      format = "binary";
      owner = "bdsqqq";
      mode = "0400";
    };
  };
}
