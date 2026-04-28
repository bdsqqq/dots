# kept as a compatibility import for hosts that still import system/vector.nix.
{ ... }:

{
  imports = [
    ./o11y
    ./hwmon-metrics.nix
  ];

  services.o11y.enable = true;
  services.hwmon-metrics.enable = true;
}
