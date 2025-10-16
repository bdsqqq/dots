{ lib, config, pkgs, inputs, ... }:
{
  home-manager.users.bdsqqq = { config, pkgs, lib, ... }: {
    imports = [ inputs.nixvim.homeManagerModules.nixvim ];
  };
}


