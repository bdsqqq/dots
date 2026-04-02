# modules/primary-user.nix
# defines a primary user option with home-manager alias for ergonomic access.
# rationale: https://discourse.nixos.org/t/idiomatic-configuration-of-home-manager-in-single-user-nixos/74165/5
{ lib, config, ... }:

{
  options.my.primaryUser = lib.mkOption {
    type = lib.types.str;
    description = "primary user for this system — used for home-manager alias and path resolution";
  };

  # alias `hm` → `home-manager.users.${primaryUser}` for terse access
  imports = [
    (lib.mkAliasOptionModule [ "hm" ] [ "home-manager" "users" config.my.primaryUser ])
  ];
}
