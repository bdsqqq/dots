{ pkgs }:

pkgs.writeShellApplication {
  name = "household-intake-smb-audit";
  runtimeInputs = [ pkgs.nodejs ];
  text = ''
    exec node ${./smb-audit.mjs} "$@"
  '';
}
