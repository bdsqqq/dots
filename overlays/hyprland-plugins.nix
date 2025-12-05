# overlays/hyprland-plugins.nix
# Use hyprland from hyprland-plugins to ensure version alignment
inputs: final: prev: {
  # Use hyprland from hyprland-plugins (they control the compatible version)
  hyprland = inputs.hyprland-plugins.inputs.hyprland.packages.${prev.system}.hyprland;
  
  # Use plugin packages from the flake
  hyprlandPlugins = (prev.hyprlandPlugins or {}) // {
    hyprscrolling = inputs.hyprland-plugins.packages.${prev.system}.hyprscrolling;
  };
}
