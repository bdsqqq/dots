# overlays/hyprland-plugins.nix
# Use Hyprland from Hyprspace flake (they track compatible versions)
inputs: final: prev: {
  # Override hyprland with the version Hyprspace uses
  # This ensures plugins and compositor are version-aligned
  hyprland = inputs.hyprspace.inputs.hyprland.packages.${prev.system}.hyprland;
  
  # Use plugin packages from their respective flakes
  hyprlandPlugins = (prev.hyprlandPlugins or {}) // {
    hyprspace = inputs.hyprspace.packages.${prev.system}.Hyprspace;
    # hyprscrolling uses different hyprland version - skip for now
    # hyprscrolling = inputs.hyprland-plugins.packages.${prev.system}.hyprscrolling;
  };
}
