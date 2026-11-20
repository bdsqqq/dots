{ lib, pkgs, hostSystem ? null, headMode ? "graphical", ... }:

if !(lib.hasInfix "linux" hostSystem) || headMode != "graphical" then
  { }
else
  let
    # app-pins records the version a mac accepted; linux follows the same pin.
    pin = (builtins.fromJSON (builtins.readFile ./app-pin.json)).linux;
    inherit (pin) version;
    asset =
      if pkgs.stdenv.hostPlatform.isx86_64 then pin.x64
      else if pkgs.stdenv.hostPlatform.isAarch64 then pin.arm64
      else throw "helium: unsupported Linux architecture ${pkgs.stdenv.hostPlatform.system}";

    appimage = pkgs.stdenvNoCC.mkDerivation {
      pname = "helium-appimage";
      inherit version;
      src = pkgs.fetchurl {
        inherit (asset) url sha256;
      };
      dontUnpack = true;
      installPhase = ''
        install -Dm755 $src $out/bin/helium.AppImage
      '';
    };

    helium-launcher = pkgs.writeShellApplication {
      name = "helium";
      runtimeInputs = [ pkgs.appimage-run ];
      text = ''
        set -euo pipefail

        # this must stay outside the syncthing folder; synced nix-store symlinks
        # can point at store paths missing on the receiving host.
        extension_dir="''${XDG_DATA_HOME:-$HOME/.local/share}/helium-remotes-extension"
        if [ -d "$extension_dir" ]; then
          exec appimage-run "${appimage}/bin/helium.AppImage" --load-extension="$extension_dir" "$@"
        fi

        exec appimage-run "${appimage}/bin/helium.AppImage" "$@"
      '';
    };
  in
  {
    home-manager.users.bdsqqq = { ... }: {
      home.packages = [ helium-launcher ];

      xdg.desktopEntries.helium = {
        name = "Helium";
        genericName = "Web Browser";
        exec = "helium %U";
        terminal = false;
        categories = [ "Network" "WebBrowser" ];
        mimeType = [
          "x-scheme-handler/http"
          "x-scheme-handler/https"
          "text/html"
        ];
      };
    };
  }
