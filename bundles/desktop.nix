{ lib, config, pkgs, ... }: {
  imports = [
    ../system/audio.nix
    ../system/bluetooth.nix
    ../system/flatpak.nix
    ../user/apps.nix
    ../user/1password.nix
    ../user/orbstack.nix
    ../user/obs
    ../user/helium.nix
    ../user/helium-remotes.nix
  ];
}

