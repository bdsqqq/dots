{ lib, hostSystem ? null, ... }:
let
  isLinux = hostSystem != null && lib.hasInfix "linux" hostSystem;
in
# On macOS, use the official Tailscale.app Network Extension rather than the
# nix-darwin tailscaled daemon; route-all/exit-node handling is more reliable.
lib.optionalAttrs isLinux {
  services.tailscale = {
    enable = true;
    extraUpFlags = lib.mkDefault [ "--ssh" ];
  };
}
