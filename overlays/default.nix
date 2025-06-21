# overlays/default.nix
# Aggregates all overlays to be used by the system
inputs: [
  # Unstable packages overlay - provides pkgs.unstable.packageName
  (import ./unstable.nix inputs)
]
