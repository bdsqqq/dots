{ pkgs }:

pkgs.writeShellApplication {
  name = "company-money-portal";
  runtimeInputs = [ pkgs.nodejs ];
  text = ''
    exec node ${./portal-server.mjs} \
      --html ${./index.html} \
      --css ${./portal.css} \
      --js ${./portal.js} \
      "$@"
  '';
}
