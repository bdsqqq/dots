# hue control is a macOS app bundle (./package.nix builds Hue Control.app),
# so its check only exists on darwin.
{ pkgs, system, lib, ... }:
lib.optionalAttrs (lib.hasSuffix "-darwin" system) {
  hue-control = import ./check.nix { inherit pkgs; };
}
