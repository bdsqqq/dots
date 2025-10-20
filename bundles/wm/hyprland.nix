{ lib, config, pkgs, ... }:
{
  imports = [
    ../../user/hyprland.nix
  ];

  home-manager.users.bdsqqq = { config, pkgs, lib, inputs, ... }: {
    imports = [
      ../../user/hyprland.nix
    ];
  };
}


