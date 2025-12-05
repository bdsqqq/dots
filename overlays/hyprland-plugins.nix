# overlays/hyprland-plugins.nix
# Use Hyprland 0.52.1 from upstream flake for plugin compatibility
inputs: final: prev: {
  # Override hyprland with the flake version (pinned to 0.52.1)
  hyprland = inputs.hyprland.packages.${prev.system}.hyprland;
  
  # Use plugin packages from their respective flakes
  hyprlandPlugins = (prev.hyprlandPlugins or {}) // {
    hyprspace = inputs.hyprspace.packages.${prev.system}.Hyprspace;
    hyprscrolling = inputs.hyprland-plugins.packages.${prev.system}.hyprscrolling;
  };
}
