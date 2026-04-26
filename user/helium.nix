# user/helium.nix
{ lib, pkgs, hostSystem ? null, headMode ? "graphical", ... }:

if !(lib.hasInfix "linux" hostSystem) || headMode != "graphical" then
  { }
else
  let
    version = "0.11.5.1";
    asset =
      if pkgs.stdenv.hostPlatform.isx86_64 then {
        suffix = "x86_64.AppImage";
        hash = "sha256-Ni7IZ9UBafr+ss0BcQaRKqmlmJI4IV1jRAJ8jhcodlg=";
      } else if pkgs.stdenv.hostPlatform.isAarch64 then {
        suffix = "arm64.AppImage";
        hash = "sha256-f3nTqFVlgOIObtvtA41w17zcguaxjc54I59anCPoM38=";
      } else
        throw "helium: unsupported Linux architecture ${pkgs.stdenv.hostPlatform.system}";

    appimage = pkgs.stdenvNoCC.mkDerivation {
      pname = "helium-appimage";
      inherit version;
      src = pkgs.fetchurl {
        url = "https://github.com/imputnet/helium-linux/releases/download/${version}/helium-${version}-${asset.suffix}";
        inherit (asset) hash;
      };
      dontUnpack = true;
      installPhase = ''
        install -Dm755 $src $out/bin/helium.AppImage
      '';
    };

    updateScript = pkgs.writeText "helium-update.py" ''
      import re
      import sys
      from pathlib import Path

      path = Path(sys.argv[1])
      version, x86_hash, arm_hash = sys.argv[2:]
      text = path.read_text()
      text = re.sub(r'version = "[^"]+";', f'version = "{version}";', text, count=1)
      text = re.sub(
          r'(suffix = "x86_64\.AppImage";\n\s+hash = ")[^"]+(";)',
          rf'\g<1>{x86_hash}\2',
          text,
          count=1,
      )
      text = re.sub(
          r'(suffix = "arm64\.AppImage";\n\s+hash = ")[^"]+(";)',
          rf'\g<1>{arm_hash}\2',
          text,
          count=1,
      )
      path.write_text(text)
    '';

    helium-update = pkgs.writeShellApplication {
      name = "helium-update";
      runtimeInputs = [ pkgs.coreutils pkgs.curl pkgs.gnugrep pkgs.gnused pkgs.nix pkgs.python3 ];
      text = ''
        set -euo pipefail

        file="''${1:-''${DOTS_NIX:-$HOME/commonplace/01_files/nix}/user/helium.nix}"
        if [ ! -f "$file" ]; then
          echo "helium-update: cannot find $file" >&2
          echo "usage: helium-update [path/to/helium.nix]" >&2
          exit 1
        fi

        latest_release="$(${pkgs.curl}/bin/curl -fsSL -H "Accept: application/vnd.github+json" \
          "https://api.github.com/repos/imputnet/helium-linux/releases/latest")"
        latest_version="$(printf '%s' "$latest_release" \
          | ${pkgs.gnugrep}/bin/grep '"tag_name": ' \
          | head -1 \
          | ${pkgs.gnused}/bin/sed 's/.*"tag_name": "//; s/",\?$//')"

        if [ -z "$latest_version" ]; then
          echo "helium-update: failed to resolve latest version" >&2
          exit 1
        fi

        hash_for() {
          suffix="$1"
          url="https://github.com/imputnet/helium-linux/releases/download/$latest_version/helium-$latest_version-$suffix"
          nix_hash="$(nix-prefetch-url "$url")"
          nix hash convert --hash-algo sha256 --to sri "$nix_hash"
        }

        x86_hash="$(hash_for x86_64.AppImage)"
        arm_hash="$(hash_for arm64.AppImage)"

        ${pkgs.python3}/bin/python3 ${updateScript} "$file" "$latest_version" "$x86_hash" "$arm_hash"

        nix fmt "$file"
        echo "helium-update: updated $file to $latest_version"
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
      home.packages = [ helium-launcher helium-update ];

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
