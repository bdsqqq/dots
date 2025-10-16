{ lib, config, pkgs, ... }:
{
  imports = [
    ../user/nvim.nix
    ../user/pnpm.nix
    ../user/dev-tools.nix
  ];
}


