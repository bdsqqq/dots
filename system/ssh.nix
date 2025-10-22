{ lib, hostSystem ? null, ... }:

if !(lib.hasInfix "linux" hostSystem) then {} else {
  services.openssh = {
    enable = true;
    settings = {
      PermitRootLogin = "no";
      PasswordAuthentication = lib.mkDefault false;
    };
  };
}


