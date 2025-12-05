{ pkgs }:

let
  # import the shared script (symlinked here as script.nix)
  toggleThemeScript = import ./script.nix { inherit pkgs; };
  
  # path to the extension source (for mkVicinaeExtension)
  extensionSrc = ./extension;
in
{
  inherit toggleThemeScript extensionSrc;
  
  # environment variable to pass to vicinae so it uses our script
  vicinaeEnv = "VICINAE_TOGGLE_THEME_CMD=${toggleThemeScript}/bin/toggle-theme";
}
