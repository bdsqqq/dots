{ pkgs }:

pkgs.writeShellApplication {
  name = "household-intake-smb-audit";
  runtimeInputs = [ pkgs.python3 ];
  text = ''
    exec python ${./smb-audit.py} "$@"
  '';
}
