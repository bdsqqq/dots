# user/helium.nix
# helium inputmethod launcher — nix ships the wrapper, helium owns its binary
# fetches latest release at runtime; works on linux and darwin
{ lib, pkgs, hostSystem ? null, headMode ? "graphical", ... }:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;

  helium-launcher = pkgs.writeShellApplication {
    name = "helium";
    runtimeInputs = [ pkgs.wget pkgs.gnutar ];
    text = ''
      case "$(uname -s)" in
        Linux)   ASSET="helium-linux.tar.gz" ;;
        Darwin)  ASSET="helium-macos.tar.gz" ;;
        *)       echo "Unsupported OS" >&2; exit 1 ;;
      esac

      DEST="$HOME/.local/bin/helium"

      if [ ! -f "$DEST" ]; then
        wget -q -O - "https://github.com/imputnet/helium/releases/latest/download/$ASSET" \
          | tar -xz -C "$(dirname $DEST)"
        chmod +x "$DEST"
      fi

      exec "$DEST" "$@"
    '';
  };
in
lib.mkIf (headMode == "graphical") {
  home.packages = [ helium-launcher ];
}
