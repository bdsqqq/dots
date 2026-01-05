{ lib, hostSystem ? null, ... }:
let
  isLinux = hostSystem != null && lib.hasInfix "linux" hostSystem;
in
if isLinux then {
  services.tailscale = {
    enable = true;
    extraUpFlags = lib.mkDefault [ "--ssh" ];
  };
} else {
  # on darwin, use the mac app store tailscale app instead of nix-darwin's tailscaled.
  # the app store app bundles its own daemon via network extension and provides
  # better macOS integration. enabling both causes race conditions on startup.
}


