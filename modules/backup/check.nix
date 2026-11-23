# the backup server; building it builds backrest, whose postCheck (./default.nix)
# runs the go tests against mmn-m4's generated config, the host that backs up.
{ self, system, lib, ... }:
lib.optionalAttrs (system == "aarch64-darwin") {
  backrest = self.darwinConfigurations.mmn-m4.config.my.backup.package;
}
