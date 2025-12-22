{ lib, pkgs, hostSystem ? null, ... }:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
in
{
  home-manager.users.bdsqqq = { pkgs, config, lib, ... }: {
    home.packages = lib.optionals isDarwin [
      pkgs.modrinth-app
    ];
    
    # flatpak modrinth uses ~/.var/app/.../data/ModrinthApp but syncthing syncs to ~/.local/share/ModrinthApp
    # use activation script to create direct symlink (home.file creates store-indirected symlinks that break flatpak)
    home.activation.modrinthSymlink = lib.mkIf isLinux (
      lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        FLATPAK_DATA="${config.home.homeDirectory}/.var/app/com.modrinth.ModrinthApp/data"
        SYNCED_DATA="${config.home.homeDirectory}/.local/share/ModrinthApp"
        
        mkdir -p "$FLATPAK_DATA"
        
        # remove existing (could be stale symlink or store-managed link)
        if [ -L "$FLATPAK_DATA/ModrinthApp" ] || [ -e "$FLATPAK_DATA/ModrinthApp" ]; then
          rm -f "$FLATPAK_DATA/ModrinthApp"
        fi
        
        ln -s "$SYNCED_DATA" "$FLATPAK_DATA/ModrinthApp"
      ''
    );
  };
}
