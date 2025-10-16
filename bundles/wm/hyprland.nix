{ lib, config, pkgs, ... }:
{
  imports = [
  ];

  home-manager.users.bdsqqq = { config, pkgs, lib, inputs, ... }: {
    imports = [
      ../../modules/home-manager/profiles/hyprland.nix
    ];
  };
}


