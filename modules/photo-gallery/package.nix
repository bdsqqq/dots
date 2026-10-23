{ pkgs }:

pkgs.writeShellApplication {
  name = "photo-gallery-server";
  runtimeInputs = [ pkgs.nodejs_latest ];
  text = ''
    exec node ${./photo-gallery-server.mjs} \
      --copyparty ${pkgs.copyparty}/bin/copyparty \
      --html ${./index.html} \
      --css ${./gallery.css} \
      --js ${./gallery.js} \
      "$@"
  '';
}
