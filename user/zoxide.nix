{ config, pkgs, ... }:
{
  home-manager.users.bdsqqq = { config, pkgs, ... }: {
    programs.zoxide.enable = true;

    home.shellAliases.cd = "z";
  };
}
