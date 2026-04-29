# kept as a compatibility import for hosts that still import system/vector.nix.
{ lib, hostSystem ? null, ... }:

let
  isLinux = lib.hasInfix "linux" hostSystem;
in
{
  imports = [ ./o11y ] ++ lib.optional isLinux ./hwmon-metrics.nix;

  services.o11y.enable = true;
}
  // lib.optionalAttrs isLinux {
  services.hwmon-metrics.enable = true;
}
