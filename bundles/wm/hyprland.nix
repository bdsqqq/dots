{ lib, config, pkgs, ... }:
{
  imports = [
    ../../system/login.nix
  ];

  programs.hyprland.enable = true;

  environment.etc."wallpaper.jpg".source = ../../assets/wallpaper.jpg;

  home-manager.users.bdsqqq = { config, pkgs, lib, inputs, ... }: {
    imports = [
      ../../user/hyprland.nix
    ];
    # cursor is managed by stylix
  };
}
