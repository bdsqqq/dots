{ lib, config, pkgs, ... }: {
  imports = [
    ../system/audio.nix
    ../system/bluetooth.nix
    ../system/cmux.nix
    ../system/flatpak.nix
    ../user/apps.nix
    ../user/e-ink-glass.nix
    ../user/1password.nix
    ../user/orbstack.nix
    ../user/obs
    ../user/helium.nix
    ../user/helium-remotes.nix
  ];
}

