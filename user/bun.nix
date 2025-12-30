{ config, pkgs, ... }:
{
  home-manager.users.bdsqqq = { config, pkgs, ... }: {
    home.sessionVariables = {
      BUN_INSTALL = "$HOME/.bun";
    };
    home.sessionPath = [
      "$HOME/.bun/bin"
    ];
  };
}
