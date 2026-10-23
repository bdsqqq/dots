{ pkgs }:

pkgs.writeShellApplication {
  name = "household-intake-smb-audit";
  runtimeInputs = [ pkgs.nodejs_latest ];
  text = ''
    exec node ${./smb-audit.mjs} "$@"
  '';
}
