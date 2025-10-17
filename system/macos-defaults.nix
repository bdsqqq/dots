{ lib, pkgs, ... }:
{
  system.defaults = lib.mkIf pkgs.stdenv.isDarwin {
    dock = {
      autohide = true;
      autohide-delay = 0.0;
      autohide-time-modifier = 0.2;
      orientation = "bottom";
      tilesize = 56;
      magnification = false;
      show-recents = false;
      minimize-to-application = true;
      expose-animation-duration = 0.1;
      wvous-tl-corner = 1;
      wvous-tr-corner = 1;
      wvous-bl-corner = 1;
      wvous-br-corner = 1;
      persistent-apps = [ ];
    };

    finder = {
      ShowPathbar = true;
      ShowStatusBar = false;
      FXPreferredViewStyle = "Nlsv";
      FXDefaultSearchScope = "SCcf";
      AppleShowAllExtensions = true;
      ShowExternalHardDrivesOnDesktop = true;
      ShowHardDrivesOnDesktop = true;
      ShowMountedServersOnDesktop = true;
      ShowRemovableMediaOnDesktop = true;
      FXEnableExtensionChangeWarning = false;
    };

    NSGlobalDomain = {
      KeyRepeat = 2;
      InitialKeyRepeat = 25;
      AppleShowScrollBars = "WhenScrolling";
      "com.apple.swipescrolldirection" = true;
      AppleInterfaceStyleSwitchesAutomatically = false;
      AppleInterfaceStyle = "Dark";
      NSWindowShouldDragOnGesture = true;
      AppleShowAllFiles = true;
    };

    trackpad = {
      Clicking = true;
      TrackpadRightClick = true;
      TrackpadThreeFingerDrag = false;
      Dragging = false;
      FirstClickThreshold = 1;
      SecondClickThreshold = 1;
      ActuationStrength = 1;
      TrackpadThreeFingerTapGesture = 2;
    };

    loginwindow = {
      GuestEnabled = false;
      SHOWFULLNAME = false;
    };
  };
}


