{ pkgs }:

pkgs.writeShellApplication {
  name = "photo-intelligence-server";
  runtimeInputs = [ pkgs.nodejs ];
  text = ''
    exec node ${./photo-intelligence-server.mjs} "$@"
  '';
}
