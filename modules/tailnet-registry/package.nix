{ bun, tailscale, writeShellApplication, substitute }:

let
  # A bare copied .ts entrypoint loses its sibling import in the store.
  source = substitute {
    src = ./tailnet-registry.ts;
    substitutions = [
      "--replace-fail"
      "\"../service-events/events.ts\""
      "\"${../service-events/events.ts}\""
    ];
  };
in
writeShellApplication {
  name = "tailnet-registry";
  runtimeInputs = [ bun tailscale ];
  text = ''
    exec bun ${source} "$@"
  '';
}
