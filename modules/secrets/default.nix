{ lib, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;

  sshKeyPath =
    if isDarwin then
      "/Users/bdsqqq/.ssh/id_ed25519"
    else
      "/home/bdsqqq/.ssh/id_ed25519";

  homeDir = if isDarwin then "/Users/bdsqqq" else "/home/bdsqqq";
in
{
  sops.age = {
    sshKeyPaths = lib.mkDefault [ sshKeyPath ];
    keyFile = if isDarwin then lib.mkDefault "${homeDir}/.config/sops/age/keys.txt" else null;
  };
}
