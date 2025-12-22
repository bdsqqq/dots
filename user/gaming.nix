{ lib, pkgs, hostSystem ? null, ... }:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
in
{
  home-manager.users.bdsqqq = { pkgs, ... }: {
    home.packages = 
      lib.optionals isDarwin [
        pkgs.modrinth-app
      ] ++
      lib.optionals isLinux [
        pkgs.prismlauncher
      ];
  };
}
