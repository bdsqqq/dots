{ lib, hostSystem ? null, ... }:
let
  isLinux = lib.hasInfix "linux" hostSystem;
  sshKeys = import ./keys { inherit lib; };
in if isLinux then {
  users.users.bdsqqq.openssh.authorizedKeys.keys = sshKeys.personalKeys;
} else
  { }
