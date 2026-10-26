{ config, lib, ... }:
{
  options.my.rex.credential.required =
    lib.mkEnableOption "the Rex package-host credential";

  config = lib.mkIf config.my.rex.credential.required {
    # nix reads this at fetch time; never interpolate the token into the store.
    sops.secrets.rex_netrc = {
      sopsFile = ./secrets.yaml;
      owner = "root";
      mode = "0400";
    };
  };
}
