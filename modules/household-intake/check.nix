# the audit shells out to /usr/bin/plutil, so it only runs on darwin.
{ pkgs, system, lib, ... }:
lib.optionalAttrs (lib.hasSuffix "-darwin" system) {
  household-intake-smb-audit = pkgs.runCommand "household-intake-smb-audit-tests" { } ''
    ${pkgs.nodejs}/bin/node --test ${./.}/smb-audit.test.mjs
    touch "$out"
  '';
}
