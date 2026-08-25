{ lib, hostSystem ? null, ... }:
let isDarwin = lib.hasInfix "darwin" hostSystem;
in if isDarwin then {
  homebrew.casks = [ "orbstack" ];

  home-manager.users.bdsqqq = { ... }: {
    programs.ssh.includes = [ "~/.orbstack/ssh/config" ];
  };
} else
  { }
