{ pkgs }:

let
  # The source import stays relative for local development; retain its runtime
  # dependency explicitly when the entrypoint becomes a standalone store file.
  events = pkgs.writeText "service-events.ts" (builtins.readFile ../service-events/events.ts);
  server = pkgs.writeText "files-browser-server.mjs" (builtins.replaceStrings
    [ "../service-events/events.ts" ]
    [ "${events}" ]
    (builtins.readFile ./files-browser-server.mjs));
in
pkgs.writeShellApplication {
  name = "files-browser-server";
  runtimeInputs = [ pkgs.nodejs_latest ];
  text = ''
    exec node ${server} \
      --copyparty ${pkgs.copyparty}/bin/copyparty \
      "$@"
  '';
}
