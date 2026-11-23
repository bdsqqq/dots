# bun runs these tests: they import bun:test and serve with Bun.serve.
{ pkgs }:
let
  source = pkgs.lib.fileset.toSource {
    root = ../..;
    fileset = pkgs.lib.fileset.unions [
      (pkgs.lib.fileset.fileFilter (file: pkgs.lib.hasSuffix ".ts" file.name) ./.)
      ../service-events/events.ts
    ];
  };
in
pkgs.runCommand "html-stuff-tests" { nativeBuildInputs = [ pkgs.bun ]; } ''
  cp -R ${source}/. source
  chmod -R u+w source
  cd source/modules/html-stuff
  bun test .
  touch "$out"
''
