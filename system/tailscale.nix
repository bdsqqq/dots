{ lib, hostSystem ? null, ... }:
let
  isLinux = hostSystem != null && lib.hasInfix "linux" hostSystem;
in
{
  # enable tailscale on all platforms
  services.tailscale.enable = true;
}
// (if isLinux then {
  # linux-only: default to enabling tailscale ssh
  services.tailscale.extraUpFlags = lib.mkDefault [ "--ssh" ];
} else {})


