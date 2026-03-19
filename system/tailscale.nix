{ lib, hostSystem ? null, ... }:
let
  isLinux = hostSystem != null && lib.hasInfix "linux" hostSystem;
in {
  services.tailscale = {
    enable = true;
  } // lib.optionalAttrs isLinux {
    extraUpFlags = lib.mkDefault [ "--ssh" ];
  };
}


