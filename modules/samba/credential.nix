{ config, lib, ... }:
{
  options.my.samba.credential.required = lib.mkEnableOption "the relay's SMB login credential";

  config = lib.mkIf config.my.samba.credential.required {
    sops.secrets.relay_smb_password = {
      sopsFile = ./secrets.yaml;
      owner = "root";
      mode = "0400";
      restartUnits = [ "samba-smbd.service" ];
    };
  };
}
