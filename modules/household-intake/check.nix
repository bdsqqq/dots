# darwin-only: the audit shells out to /usr/bin/plutil.
{ pkgs }:
pkgs.runCommand "household-intake-smb-audit-tests" { } ''
  ${pkgs.nodejs}/bin/node --test ${./.}/smb-audit.test.mjs
  touch "$out"
''
