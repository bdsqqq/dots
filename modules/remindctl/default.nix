{ lib, hostSystem ? "", ... }:
# Shape must use an external argument: pkgs depends on the module configuration.
# mkIf would retain undeclared homebrew options during NixOS option checking.
lib.optionalAttrs (lib.hasInfix "darwin" hostSystem) {
  # Upstream's signed native binary requires macOS 14+ and EventKit permission.
  homebrew.taps = [ "steipete/tap" ];
  homebrew.brews = [ "remindctl" ];
}
