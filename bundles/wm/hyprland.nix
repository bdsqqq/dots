{ lib, config, pkgs, ... }:
{
  imports = [
    ../../system/login.nix
  ];

  home-manager.users.bdsqqq = { config, pkgs, lib, inputs, ... }: {
    imports = [
      ../../user/hyprland.nix
    ];
  };
}


