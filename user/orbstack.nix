{ lib, hostSystem ? null, ... }:
let isDarwin = lib.hasInfix "darwin" hostSystem;
in lib.mkIf isDarwin {
  homebrew.casks = [ "orbstack" ];

  home-manager.users.bdsqqq = { ... }: {
    programs.ssh.includes = [ "~/.orbstack/ssh/config" ];
  };
}
