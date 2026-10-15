{ config, lib, ... }:
{
  options.my.restic.ssd01.credential.required =
    lib.mkEnableOption "the shared ssd-01 restic repository credential";

  config = lib.mkIf config.my.restic.ssd01.credential.required {
    sops.secrets.restic_ssd_01_password = {
      sopsFile = ./secrets.yaml;
      owner = config.my.primaryUser;
      mode = "0400";
    };
  };
}
