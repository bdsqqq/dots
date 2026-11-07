{ pkgs }:

let
  source = pkgs.writeText "html-stuff-server.ts" (builtins.replaceStrings
    [ "../service-events/events.ts" "./lifecycle.ts" ]
    [ "${../service-events/events.ts}" "${./lifecycle.ts}" ]
    (builtins.readFile ./server.ts));
in
pkgs.writeShellApplication {
  name = "html-stuff-server";
  runtimeInputs = [ pkgs.bun ];
  text = ''
    exec bun run ${source} "$@"
  '';
}
