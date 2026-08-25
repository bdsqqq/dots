{ pkgs }:

let
  source = pkgs.writeText "html-stuff-server.ts" (builtins.readFile ./server.ts);
in
pkgs.writeShellApplication {
  name = "html-stuff-server";
  runtimeInputs = [ pkgs.bun ];
  text = ''
    bun_pid=""
    cleanup() {
      if [[ -n "$bun_pid" ]] && kill -0 "$bun_pid" 2>/dev/null; then
        kill "$bun_pid"
        wait "$bun_pid" 2>/dev/null || true
      fi
    }
    trap cleanup EXIT
    trap 'exit 143' TERM
    trap 'exit 130' INT

    bun run ${source} "$@" &
    bun_pid=$!
    wait "$bun_pid"
  '';
}
