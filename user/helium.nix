# user/helium.nix
# helium browser — binaries at imputnet/helium-linux
{ lib, pkgs, headMode ? "graphical", ... }:

let
  helium-launcher = pkgs.writeShellApplication {
    name = "helium";
    runtimeInputs = [ pkgs.curl pkgs.xz ];
    text = ''
      DEST="/etc/profiles/per-user/bdsqqq/bin/helium"

      # latest release: query API once to get version, then pin the URL
      # avoids re-parsing HTML on every launch
      TAG=$(curl -sL -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/imputnet/helium-linux/releases/latest" \
        | grep -o '"tag_name": "[^"]*"' | head -1 | sed 's/"tag_name": "//;s/"//')

      if [ -z "$TAG" ]; then
        echo "helium: failed to fetch latest release tag" >&2
        exit 1
      fi

      if [ ! -f "$DEST" ]; then
        curl -fsSL \
          "https://github.com/imputnet/helium-linux/releases/download/$TAG/helium-$TAG-x86_64_linux.tar.xz" \
          | tar -xJ -C "$(dirname "$DEST")" --strip-components=1
        chmod +x "$DEST"
      fi

      exec "$DEST" "$@"
    '';
  };
in
lib.mkIf (headMode == "graphical") {
  home-manager.users.bdsqqq = { pkgs, ... }: {
    home.packages = [ helium-launcher ];
  };
}
