{ lib, hostSystem ? null, ... }:
let
  isLinux = lib.hasInfix "linux" hostSystem;
  sshKeys = import ./keys { inherit lib; };
in
if isLinux then
  {
    users.users.bdsqqq.openssh.authorizedKeys.keys = sshKeys.personalKeys;
  }
else
  {
    # OpenSSH StrictModes rejects Home Manager's usual symlink because its
    # path traverses the group-writable Nix store. Keep the source declarative,
    # but atomically install a user-owned regular file for sshd to read.
    home-manager.users.bdsqqq = { lib, pkgs, ... }:
    let
      authorizedKeys = pkgs.writeText "authorized_keys" (
        lib.concatStringsSep "\n" (sshKeys.personalKeys ++ sshKeys.openDisplayPortalKeys) + "\n"
      );
    in
    {
      home.activation.installAuthorizedKeys = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        $DRY_RUN_CMD ${pkgs.coreutils}/bin/install -d -m 0700 "$HOME/.ssh"
        $DRY_RUN_CMD ${pkgs.coreutils}/bin/install -m 0600 ${authorizedKeys} "$HOME/.ssh/.authorized_keys.new"
        $DRY_RUN_CMD ${pkgs.coreutils}/bin/mv -f "$HOME/.ssh/.authorized_keys.new" "$HOME/.ssh/authorized_keys"
      '';
    };
  }
