{ lib, pkgs, ... }:
{
  # define ssh only on linux; avoid creating the 'services.openssh.settings' path on darwin entirely
  services = lib.optionalAttrs pkgs.stdenv.isLinux {
    openssh = {
      enable = true;
      settings = {
        PermitRootLogin = "no";
        PasswordAuthentication = lib.mkDefault false;
      };
    };
  };
}


