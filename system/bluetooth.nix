{ lib, config, pkgs, ... }:
{
  # Linux desktop bluetooth manager; no-op on darwin
  services.blueman.enable = lib.mkIf pkgs.stdenv.isLinux true;
}


