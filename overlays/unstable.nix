# overlays/unstable.nix
# Overlay to provide access to unstable packages as pkgs.unstable.packageName
# while keeping stable packages as default
inputs: final: prev: {
  # Make unstable packages available under pkgs.unstable namespace
  # Usage: pkgs.unstable.packageName for bleeding edge packages
  # Usage: pkgs.packageName for stable packages (default)
  unstable = import inputs.nixpkgs-unstable {
    inherit (final) system;
    config.allowUnfree = true;
  };
}
