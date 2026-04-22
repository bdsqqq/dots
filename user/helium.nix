# user/helium.nix
# helium bootstrapper — nix provides a stable launcher, upstream owns updates in a user-writable AppImage
{ lib, pkgs, hostSystem ? null, headMode ? "graphical", ... }:

if !(lib.hasInfix "linux" hostSystem) || headMode != "graphical" then
  { }
else
  let
    helium-launcher = pkgs.writeShellApplication {
      name = "helium";
      runtimeInputs =
        [ pkgs.appimage-run pkgs.coreutils pkgs.curl pkgs.gnugrep pkgs.gnused ];
      text = ''
        set -euo pipefail

        case "$(uname -m)" in
          x86_64|amd64) asset_suffix="x86_64.AppImage" ;;
          aarch64|arm64) asset_suffix="arm64.AppImage" ;;
          *) echo "helium: unsupported Linux architecture $(uname -m)" >&2; exit 1 ;;
        esac

        dest_dir="''${XDG_DATA_HOME:-$HOME/.local/share}/helium"
        dest="$dest_dir/Helium.AppImage"

        if [ ! -x "$dest" ]; then
          mkdir -p "$dest_dir"

          asset_url="$(${pkgs.curl}/bin/curl -fsSL -H "Accept: application/vnd.github+json" \
            "https://api.github.com/repos/imputnet/helium-linux/releases/latest" \
            | ${pkgs.gnugrep}/bin/grep '"browser_download_url": ' \
            | ${pkgs.gnugrep}/bin/grep "''${asset_suffix}\"" \
            | head -1 \
            | ${pkgs.gnused}/bin/sed 's/.*"browser_download_url": "//; s/",\?$//')"

          if [ -z "$asset_url" ]; then
            echo "helium: failed to find Linux AppImage URL" >&2
            exit 1
          fi

          ${pkgs.curl}/bin/curl -fL "$asset_url" -o "$dest"
          chmod +x "$dest"
        fi

        exec appimage-run "$dest" "$@"
      '';
    };
  in {
    home-manager.users.bdsqqq = { ... }: {
      home.packages = [ helium-launcher ];
    };
  }
