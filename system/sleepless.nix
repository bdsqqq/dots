{ config, lib, hostSystem ? null, ... }:

if !(lib.hasInfix "darwin" hostSystem) then
  { }
else
  {
    homebrew.casks = [ "aboudjem/tap/sleepless" ];

    security.sudo.extraConfig = ''
      ${config.system.primaryUser} ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1
    '';
  }
