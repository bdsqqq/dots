# overlays/hyprland-plugins.nix
# Use Hyprland and plugins from upstream flakes for version alignment
inputs: final: prev: {
  # Override hyprland with the flake version
  hyprland = inputs.hyprland.packages.${prev.system}.hyprland;
  
  # Use plugin packages from their respective flakes
  hyprlandPlugins = (prev.hyprlandPlugins or {}) // {
    hyprspace = inputs.hyprspace.packages.${prev.system}.Hyprspace;
    hyprscrolling = inputs.hyprland-plugins.packages.${prev.system}.hyprscrolling;
  };
}
