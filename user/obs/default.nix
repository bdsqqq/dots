{ lib, hostSystem ? null, headMode ? "graphical", ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  obsConfig = "$HOME/commonplace/01_files/nix/user/obs";
  obsState = "$HOME/Library/Application Support/obs-studio";
in lib.mkIf (headMode == "graphical" && isDarwin) {
  home-manager.users.bdsqqq = { lib, ... }: {
    home.activation.obsCallRecordingConfig = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      mkdir -p "${obsState}/basic/profiles"

      rm -rf "${obsState}/basic/scenes"
      rm -rf "${obsState}/basic/profiles/call-recording"

      ln -sfn "${obsConfig}/basic/scenes" \
              "${obsState}/basic/scenes"
      ln -sfn "${obsConfig}/basic/profiles/call-recording" \
              "${obsState}/basic/profiles/call-recording"
    '';
  };
}
