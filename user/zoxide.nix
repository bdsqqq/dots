{ config, pkgs, ... }:
{
  home-manager.users.bdsqqq = { config, pkgs, ... }: {
    programs.zoxide = {
      enable = true;
      enableZshIntegration = true;
    };

    programs.zsh.shellAliases.cd = "z";
  };
}
