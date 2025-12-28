{ lib, pkgs, hostSystem ? null, ... }:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
  
  # launch steam big picture in gamescope to avoid gesture conflicts with niri
  steam-gamescope = pkgs.writeShellScriptBin "steam-gamescope" ''
    exec ${pkgs.gamescope}/bin/gamescope \
      -e \
      -f \
      --adaptive-sync \
      --expose-wayland \
      -- steam -gamepadui -steamos
  '';
in
{
  home-manager.users.bdsqqq = { pkgs, ... }: {
    home.packages = [
      pkgs.prismlauncher
    ] ++ lib.optionals isDarwin [
    ] ++ lib.optionals isLinux [
      steam-gamescope
      pkgs.gamescope
    ];
  };
}
