{ lib, config, pkgs, ... }:
{
  # OpenSSH is configured on Linux; darwin uses different service semantics
  services.openssh = lib.mkIf pkgs.stdenv.isLinux {
    enable = true;
    settings = {
      PermitRootLogin = "no";
      PasswordAuthentication = lib.mkDefault false;
    };
  };
}


