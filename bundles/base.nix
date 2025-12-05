{ lib, config, pkgs, ... }:
{
  imports = [
    ../system/nix.nix
    ../system/ssh.nix
    ../system/tailscale.nix
    ../system/sops.nix
    ../system/authorized-keys.nix
    ../user/path-order.nix
    ../user/shell.nix
    ../user/homebrew.nix
    ../user/bun.nix
    ../user/sdkman.nix
    ../user/fnm.nix
    ../user/fzf.nix
    ../user/zoxide.nix
    ../user/zellij.nix
    ../system/fonts.nix
  ];
}


