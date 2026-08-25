{ pkgs }:

pkgs.writeShellApplication {
  name = "files-browser-server";
  runtimeInputs = [ pkgs.nodejs ];
  text = ''
    exec node ${./files-browser-server.mjs} \
      --copyparty ${pkgs.copyparty}/bin/copyparty \
      "$@"
  '';
}
