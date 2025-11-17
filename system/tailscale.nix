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
  services.tailscale.enable = true;
}


