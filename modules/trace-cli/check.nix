{ pkgs }:

let
  source = pkgs.lib.fileset.toSource {
    root = ../..;
    fileset = pkgs.lib.fileset.unions [
      ../service-events/events.ts
      ./baseline.json
      (pkgs.lib.fileset.fileFilter (file: pkgs.lib.hasSuffix ".ts" file.name) ./.)
    ];
  };
in
pkgs.runCommand "trace-cli-tests" {
  nativeBuildInputs = [ pkgs.nodejs_latest ];
  __darwinAllowLocalNetworking = true;
} ''
  cp -R ${source}/. source
  chmod -R u+w source
  cd source
  node --experimental-strip-types --test modules/trace-cli/trace-cli.test.ts
  touch "$out"
''
