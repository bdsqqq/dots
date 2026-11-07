{ pkgs }:

let
  # The source import stays relative for local development; retain its runtime
  # dependency explicitly when the entrypoint becomes a standalone store file.
  events = pkgs.writeText "service-events.ts" (builtins.readFile ../service-events/events.ts);
  recovery = pkgs.writeText "files-browser-recovery.ts" (builtins.readFile ./recovery.ts);
  server = pkgs.writeText "files-browser-server.mjs" (builtins.replaceStrings
    [ "../service-events/events.ts" "./recovery.ts" ]
    [ "${events}" "${recovery}" ]
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
