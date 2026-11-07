{ pkgs }:

let
  source = pkgs.lib.fileset.toSource {
    root = ../..;
    fileset = pkgs.lib.fileset.unions [
      ./events.ts
      ./events.test.ts
      ./projections.test.ts
      ../nix/host-upgrade.ts
      ../nix/upgrade-status.ts
      ../nix/host-upgrade.test.ts
      ../o11y/papertrail-virtual-fields.json
      ../o11y/monitors.json
      ../o11y/incidents/webhook-body.tmpl
      ../o11y/incidents/watchdog-body.tmpl
      (pkgs.lib.fileset.fileFilter (file: pkgs.lib.hasSuffix ".ts" file.name) ../o11y/incidents)
      ../cloudflare-ingress/origin-check.ts
      ../cloudflare-ingress/origin-check.test.ts
      ../files-browser/files-browser-server.mjs
      ../files-browser/files-browser-server.test.mjs
      ../files-browser/service-events.test.ts
      ../files-browser/readiness.test.mjs
      ../files-browser/recovery.ts
      ../files-browser/recovery.test.mjs
      ../photo-gallery/photo-gallery-server.mjs
      ../photo-gallery/photo-gallery-server.test.mjs
      ../photo-gallery/service-events.test.ts
      ../photo-intelligence/photo-intelligence-server.mjs
      ../photo-intelligence/photo-intelligence-server.test.mjs
      ../photo-intelligence/service-events.test.ts
      ../photo-intelligence/startup-events.test.ts
    ];
  };
in
pkgs.runCommand "service-events-tests" {
  nativeBuildInputs = [ pkgs.nodejs_latest ];
  __darwinAllowLocalNetworking = true;
} ''
  cp -R ${source}/. source
  chmod -R u+w source
  cd source
  node --experimental-strip-types --test \
    modules/service-events/events.test.ts \
    modules/service-events/projections.test.ts \
    modules/nix/host-upgrade.test.ts \
    modules/cloudflare-ingress/origin-check.test.ts \
    modules/o11y/incidents/*.test.ts \
    modules/files-browser/files-browser-server.test.mjs \
    modules/files-browser/service-events.test.ts \
    modules/files-browser/readiness.test.mjs \
    modules/files-browser/recovery.test.mjs \
    modules/photo-gallery/photo-gallery-server.test.mjs \
    modules/photo-gallery/service-events.test.ts \
    modules/photo-intelligence/photo-intelligence-server.test.mjs \
    modules/photo-intelligence/service-events.test.ts \
    modules/photo-intelligence/startup-events.test.ts
  touch "$out"
''
