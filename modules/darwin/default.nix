{ config, pkgs, inputs, lib, ... }:

{
  imports = [
    ./karabiner.nix
    ../shared/default.nix
  ];
  # List packages installed in system profile. To search by name, run:
  # $ nix-env -qaP | grep wget
  environment.systemPackages = [
    pkgs.vim
    # Test unstable overlay - uncomment to test unstable packages
    # pkgs.unstable.neovim  # Example: Use unstable neovim
  ];

  users.users.bdsqqq = {
    home = "/Users/bdsqqq";
  };

  # Set primary user for system-wide defaults
  system.primaryUser = "bdsqqq";

  environment.darwinConfig = "$HOME/.config/nix-darwin/configuration.nix";

  # Necessary for using flakes on this system.
  nix.settings.experimental-features = "nix-command flakes";

  # Enable alternative shell support in nix-darwin.
  # programs.fish.enable = true;

  # Set Git commit hash for darwin-version.
  # system.configurationRevision = self.rev or self.dirtyRev or null;

  # Networking configuration
  networking = {
    computerName = lib.mkDefault "mbp14";
    localHostName = lib.mkDefault "mbp14";
    hostName = lib.mkDefault "mbp14";
  };

  # Homebrew integration - declarative cask management
  homebrew = {
    enable = true;
    
    # Applications to install via homebrew casks
    casks = [
      # Password management
      "1password"
      "1password-cli"
      
      # System utilities (Mac-specific)
      "superwhisper"         # Audio transcribing
      "blackhole-2ch"        # Audio routing
      "cleanshot"            # Screenshot tool  
      "karabiner-elements"   # Keyboard customization
      "raycast"              # Launcher/productivity
      
      # Development tools
      # "docker"               # Container runtime - has installation conflicts
      "orbstack"             # Docker alternative
      "tableplus"            # Database GUI
      "ghostty"              # Terminal - nixpkgs version broken on Darwin
      
      # Creative/Media tools
      "blockbench"           # 3D model editor
      "figma"                # Design tool
      "iina"                 # Video player
      "obs"                  # Streaming software
      "transmission"         # Torrent client
      
      # Productivity applications
      "linear-linear"        # Project management
      "notion-calendar"      # Calendar app
      "obsidian"             # Note-taking
      
      # Entertainment/Gaming
      "prismlauncher"        # Minecraft launcher
      "spotify"              # Music streaming
      "steam"                # Gaming platform
      
      # Browsers
      # Note: zen-browser not yet available in homebrew
      # Manual install required for now
      "chromium"
    ];
    
    # Clean up orphaned applications
    onActivation.cleanup = "zap";
    
    # Auto-update homebrew itself
    onActivation.autoUpdate = true;
  };

  # Used for backwards compatibility, please read the changelog before changing.
  # $ darwin-rebuild changelog
  system.stateVersion = 6;

  # The platform the configuration will be used on.
  nixpkgs.hostPlatform = "aarch64-darwin";

  # Allow unfree packages
  nixpkgs.config.allowUnfree = true;

  # Configure overlays for unstable packages access
  # Provides pkgs.unstable.packageName for bleeding edge packages
  # Default pkgs.packageName remains stable
  nixpkgs.overlays = [
    # Unstable packages overlay - provides pkgs.unstable.packageName
    (final: prev: {
      unstable = import inputs.nixpkgs-unstable {
        inherit (final) system;
        config.allowUnfree = true;
      };
    })
  ];

  # macOS System Defaults - Complete Configuration
  system.defaults = {
    # Dock Configuration - Minimalist setup matching current preferences
    dock = {
      # Auto-hide dock when not in use for cleaner desktop
      autohide = true;
      autohide-delay = 0.0;         # No delay before hiding
      autohide-time-modifier = 0.2; # Faster hide/show animation

      # Dock positioning and appearance
      orientation = "bottom";        # Dock at bottom of screen
      tilesize = 56;                # Current preference: 56px tiles
      magnification = false;        # Disable icon magnification on hover
      
      # App management and behavior - minimalist approach
      show-recents = false;         # Don't show recently used apps
      minimize-to-application = true; # Minimize windows into app icon
      # static-only removed - allow dock to show all apps
      
      # Window management
      expose-animation-duration = 0.1; # Faster Mission Control animation
      
      # Hot corners - all disabled (only bottom-right shows disabled state)
      wvous-tl-corner = 1;  # Top-left: Disabled
      wvous-tr-corner = 1;  # Top-right: Disabled  
      wvous-bl-corner = 1;  # Bottom-left: Disabled
      wvous-br-corner = 1;  # Bottom-right: Disabled

      # No pinned applications - empty dock
      persistent-apps = [ ];
    };

    # Finder Configuration - Power user setup with detailed information
    finder = {
      # Path and status bars
      ShowPathbar = true;           # Show path bar at bottom
      ShowStatusBar = false;        # Status bar disabled
      
      # Default view settings
      FXPreferredViewStyle = "Nlsv"; # List view as default
      FXDefaultSearchScope = "SCcf"; # Search current folder by default
      
      # File extension and preview settings
      AppleShowAllExtensions = true; # Always show file extensions
      ShowExternalHardDrivesOnDesktop = true;
      ShowHardDrivesOnDesktop = true;
      ShowMountedServersOnDesktop = true;
      ShowRemovableMediaOnDesktop = true;
      
      # Advanced options
      FXEnableExtensionChangeWarning = false; # Don't warn on extension changes
    };

    # Keyboard Configuration - Fast repeat rates for power users
    NSGlobalDomain = {
      # Keyboard repeat settings
      KeyRepeat = 2;                # Very fast key repeat (1-120, lower = faster)
      InitialKeyRepeat = 25;        # Short initial delay (10-120, lower = shorter)
      
      # System UI preferences
      AppleShowScrollBars = "WhenScrolling"; # Never | WhenScrolling | Automatic
      "com.apple.swipescrolldirection" = true; # Natural scrolling enabled
      
      # Interface style
      AppleInterfaceStyleSwitchesAutomatically = false;
      AppleInterfaceStyle = "Dark";  # Dark mode enabled

      NSWindowShouldDragOnGesture = true; # Move windows with cursor anywhere while holding ctrl+cmd
      AppleShowAllFiles = true; # Show hidden files
    };

    # Trackpad Configuration - Basic clicking and gestures
    trackpad = {
      # Basic clicking options
      Clicking = true;                     # Tap to click enabled
      TrackpadRightClick = true;           # Secondary click enabled  
      TrackpadThreeFingerDrag = false;     # Three finger drag disabled
      Dragging = false;                    # Tap-to-drag disabled
      
      # Click pressure settings
      FirstClickThreshold = 1;             # Medium click pressure
      SecondClickThreshold = 1;            # Medium force touch pressure
      ActuationStrength = 1;               # Normal clicking (not silent)
      
      # Three finger tap gesture
      TrackpadThreeFingerTapGesture = 2;   # Look up & data detectors
    };

    # Login Window Configuration
    loginwindow = {
      GuestEnabled = false;         # Disable guest user
      SHOWFULLNAME = false;         # Show username, not full name
    };
  };
}
