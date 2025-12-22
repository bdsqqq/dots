{ lib, pkgs, hostSystem ? null, ... }:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
in
{
  home-manager.users.bdsqqq = { pkgs, config, ... }: {
    home.packages = lib.optionals isDarwin [
      pkgs.modrinth-app
    ];
    
    # flatpak modrinth uses ~/.var/app/.../data/ModrinthApp but syncthing syncs to ~/.local/share/ModrinthApp
    # symlink so flatpak reads the synced data
    home.file = lib.mkIf isLinux {
      ".var/app/com.modrinth.ModrinthApp/data/ModrinthApp".source =
        config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.local/share/ModrinthApp";
    };
  };
}
