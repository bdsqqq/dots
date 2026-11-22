# building backrest runs its go tests (postCheck in ./default.nix) against a
# host's generated config. mmn-m4 runs the backups, so its config is the one
# under test.
{ self }:
self.darwinConfigurations.mmn-m4.config.my.backup.backendPackage
