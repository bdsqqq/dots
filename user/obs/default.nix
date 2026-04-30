{ lib, hostSystem ? null, headMode ? "graphical", ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  obsConfig = "$HOME/commonplace/01_files/nix/user/obs";
  obsState = "$HOME/Library/Application Support/obs-studio";
in lib.mkIf (headMode == "graphical" && isDarwin) {
  home-manager.users.bdsqqq = { lib, ... }: {
    home.activation.obsCallRecordingConfig = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      mkdir -p "${obsState}/basic/scenes" \
               "${obsState}/basic/profiles/call-recording"

      ln -sf "${obsConfig}/basic/scenes/call-recording.json" \
             "${obsState}/basic/scenes/call-recording.json"
      ln -sf "${obsConfig}/basic/profiles/call-recording/basic.ini" \
             "${obsState}/basic/profiles/call-recording/basic.ini"
      ln -sf "${obsConfig}/basic/profiles/call-recording/service.json" \
             "${obsState}/basic/profiles/call-recording/service.json"
      ln -sf "${obsConfig}/basic/profiles/call-recording/streamEncoder.json" \
             "${obsState}/basic/profiles/call-recording/streamEncoder.json"
    '';
  };
}
