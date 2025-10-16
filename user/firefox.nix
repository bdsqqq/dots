{ lib, config, pkgs, inputs, ... }:
{
  home-manager.users.bdsqqq = { config, pkgs, lib, ... }: {
    imports = [ ];
    # firefox is HM-level in this repo
    programs.firefox.enable = true;
    # textfox and settings remain in user layer; system policies (if any) can be split later
  };
}


