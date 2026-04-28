# kept as a compatibility import for hosts that still import system/vector.nix.
{ ... }:

{
  imports = [ ./axiom ];
  services.axiom.enable = true;
}
