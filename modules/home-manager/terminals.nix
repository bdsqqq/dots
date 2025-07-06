{ config, pkgs, lib, isDarwin ? false, ... }:

{
  # Ghostty terminal configuration
  home.file.".config/ghostty/config" = {
    force = true;  # Force overwrite existing file
    text = ''
      # E-ink color scheme for Ghostty
      
      # Background and foreground
      background = 101010
      foreground = c2c2c2
      
      # Cursor
      cursor-color = c2c2c2
      
      # Selection
      selection-background = 4a4a4a
      selection-foreground = c2c2c2
      
      # Colors (0-15)
      palette = 0=#101010
      palette = 1=#7c7c7c
      palette = 2=#aeaeae
      palette = 3=#9a9a9a
      palette = 4=#868686
      palette = 5=#868686
      palette = 6=#b8b8b8
      palette = 7=#c2c2c2
      palette = 8=#5e5e5e
      palette = 9=#7c7c7c
      palette = 10=#aeaeae
      palette = 11=#9a9a9a
      palette = 12=#868686
      palette = 13=#868686
      palette = 14=#b8b8b8
      palette = 15=#eeeeee
      
      # Font configuration
      font-family = JetBrainsMono Nerd Font
      font-size = 12
      
      # Window settings - minimalist, no chrome
      window-decoration = false
      window-padding-x = 12
      window-padding-y = 12
      window-inherit-working-directory = true
      window-inherit-font-size = true
      
      # Transparency for modern aesthetic (niri will handle this)
      background-opacity = 0.98
      unfocused-split-opacity = 0.95
    '';
  };
  
  # Light variant configuration (commented out)
  # Uncomment and comment out the dark config above to use light theme
  /*
  home.file.".config/ghostty/config" = {
    text = ''
      # E-ink light color scheme for Ghostty
      
      # Background and foreground
      background = cccccc
      foreground = 868686
      
      # Cursor
      cursor-color = 868686
      
      # Selection
      selection-background = b8b8b8
      selection-foreground = 868686
      
      # Colors (0-15)
      palette = 0=#c2c2c2
      palette = 1=#333333
      palette = 2=#9a9a9a
      palette = 3=#868686
      palette = 4=#727272
      palette = 5=#aeaeae
      palette = 6=#4a4a4a
      palette = 7=#5e5e5e
      palette = 8=#5e5e5e
      palette = 9=#333333
      palette = 10=#9a9a9a
      palette = 11=#868686
      palette = 12=#727272
      palette = 13=#aeaeae
      palette = 14=#4a4a4a
      palette = 15=#7c7c7c
      
      # Font configuration
      font-family = JetBrainsMono Nerd Font
      font-size = 12
      
      # Window settings
      window-decoration = false
      window-padding-x = 8
      window-padding-y = 8
      
      # Disable transparency for e-ink look
      background-opacity = 1.0
      unfocused-split-opacity = 1.0
    '';
  };
  */
}