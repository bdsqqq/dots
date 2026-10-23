{ pkgs }:

pkgs.writeShellApplication {
  name = "photo-intelligence-server";
  runtimeInputs = [ pkgs.nodejs_latest ];
  text = ''
    exec node ${./photo-intelligence-server.mjs} "$@"
  '';
}
