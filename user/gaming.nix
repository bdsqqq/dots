{ lib, pkgs, hostSystem ? null, ... }:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
in
{
  home-manager.users.bdsqqq = { pkgs, ... }: {
    home.packages = [
      pkgs.prismlauncher
    ] ++ lib.optionals isDarwin [
      pkgs.modrinth-app
    ];
  };
}
