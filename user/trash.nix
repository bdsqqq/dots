{ lib, pkgs, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;

  # trash-cli is freedesktop-native, so on darwin we keep the same binary but
  # default it into ~/.Trash. finder empty will catch it there, even though the
  # on-disk layout remains trash-cli's files/info structure.
  trashCliDarwin = pkgs.symlinkJoin {
    name = "trash-cli-darwin";
    paths = [ pkgs.trash-cli ];
    buildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      for cmd in trash trash-put trash-empty trash-list trash-restore trash-rm; do
        rm "$out/bin/$cmd"
        makeWrapper ${pkgs.trash-cli}/bin/$cmd "$out/bin/$cmd" \
          --run 'needs_trash_dir=1
for arg in "$@"; do
  case "$arg" in
    --trash-dir|--trash-dir=*) needs_trash_dir=0 ;;
  esac
done
if [ "$needs_trash_dir" -eq 1 ]; then
  set -- --trash-dir "$HOME/.Trash" "$@"
fi'
      done
    '';
  };
in {
  home-manager.users.bdsqqq = {
    home.packages = [ (if isDarwin then trashCliDarwin else pkgs.trash-cli) ];
  };
}
