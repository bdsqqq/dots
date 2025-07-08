{ config, pkgs, lib, inputs, ... }:

{
  wayland.windowManager.hyprland = {
    enable = true;
    package = inputs.hyprland.packages.${pkgs.system}.hyprland;
    
    settings = {
      # Monitor configuration
      monitor = [
        ",preferred,auto,1"
      ];
      
      # Environment variables
      env = [
        "XCURSOR_SIZE,24"
        "HYPRCURSOR_SIZE,24"
        # NVIDIA specific
        "LIBVA_DRIVER_NAME,nvidia"
        "XDG_SESSION_TYPE,wayland"
        "GBM_BACKEND,nvidia-drm"
        "__GLX_VENDOR_LIBRARY_NAME,nvidia"
        "WLR_NO_HARDWARE_CURSORS,1"
      ];
      
      # Startup applications
      exec-once = [
        "waybar"
        "hyprpaper"
        "mako"
        "nm-applet"
        # "hypridle"
      ];
      
      # Input configuration
      input = {
        kb_layout = "us";
        follow_mouse = 1;
        touchpad = {
          natural_scroll = false;
        };
        sensitivity = 0;
      };
      
      # General settings
      general = {
        gaps_in = 5;
        gaps_out = 20;
        border_size = 2;
        # Use stylix colors for borders
        "col.active_border" = "rgba(33ccffee) rgba(00ff99ee) 45deg";
        "col.inactive_border" = "rgba(595959aa)";
        resize_on_border = false;
        allow_tearing = false;
        layout = "dwindle";
      };
      
      # Decoration settings
      decoration = {
        rounding = 10;
        active_opacity = 0.65;
        inactive_opacity = 0.65;
        
        drop_shadow = true;
        shadow_range = 4;
        shadow_render_power = 3;
        "col.shadow" = "rgba(1a1a1aee)";
        
        # Blur settings
        blur = {
          enabled = true;
          size = 8;
          passes = 1;
          vibrancy = 0.1696;
        };
      };
      
      # Animation settings
      animations = {
        enabled = true;
        bezier = "myBezier, 0.05, 0.9, 0.1, 1.05";
        animation = [
          "windows, 1, 7, myBezier"
          "windowsOut, 1, 7, default, popin 80%"
          "border, 1, 10, default"
          "borderangle, 1, 8, default"
          "fade, 1, 7, default"
          "workspaces, 1, 6, default"
        ];
      };
      
      # Layout settings
      dwindle = {
        pseudotile = true;
        preserve_split = true;
      };
      
      master = {
        new_is_master = true;
      };
      
      # Gestures
      gestures = {
        workspace_swipe = false;
      };
      
      # Miscellaneous
      misc = {
        force_default_wallpaper = -1;
        disable_hyprland_logo = false;
      };
      
      # Key bindings
      "$mod" = "SUPER";
      
      bind = [
        # Application shortcuts
        "$mod, Q, exec, ghostty"
        "$mod, C, killactive"
        "$mod, M, exit"
        "$mod, E, exec, nautilus"
        "$mod, V, togglefloating"
        "$mod, R, exec, wofi --show drun"
        "$mod, P, pseudo"
        "$mod, J, togglesplit"
        
        # Move focus
        "$mod, left, movefocus, l"
        "$mod, right, movefocus, r"
        "$mod, up, movefocus, u"
        "$mod, down, movefocus, d"
        
        # Move windows
        "$mod SHIFT, left, movewindow, l"
        "$mod SHIFT, right, movewindow, r"
        "$mod SHIFT, up, movewindow, u"
        "$mod SHIFT, down, movewindow, d"
        
        # Workspace navigation
        "$mod, 1, workspace, 1"
        "$mod, 2, workspace, 2"
        "$mod, 3, workspace, 3"
        "$mod, 4, workspace, 4"
        "$mod, 5, workspace, 5"
        "$mod, 6, workspace, 6"
        "$mod, 7, workspace, 7"
        "$mod, 8, workspace, 8"
        "$mod, 9, workspace, 9"
        "$mod, 0, workspace, 10"
        
        # Move windows to workspace
        "$mod SHIFT, 1, movetoworkspace, 1"
        "$mod SHIFT, 2, movetoworkspace, 2"
        "$mod SHIFT, 3, movetoworkspace, 3"
        "$mod SHIFT, 4, movetoworkspace, 4"
        "$mod SHIFT, 5, movetoworkspace, 5"
        "$mod SHIFT, 6, movetoworkspace, 6"
        "$mod SHIFT, 7, movetoworkspace, 7"
        "$mod SHIFT, 8, movetoworkspace, 8"
        "$mod SHIFT, 9, movetoworkspace, 9"
        "$mod SHIFT, 0, movetoworkspace, 10"
        
        # Special workspace
        "$mod, S, togglespecialworkspace, magic"
        "$mod SHIFT, S, movetoworkspace, special:magic"
        
        # Scroll through workspaces
        "$mod, mouse_down, workspace, e+1"
        "$mod, mouse_up, workspace, e-1"
        
        # Screenshot
        ", Print, exec, grim -g \"$(slurp)\" - | wl-copy"
        "SHIFT, Print, exec, grim - | wl-copy"
        
        # Volume controls
        ", XF86AudioRaiseVolume, exec, wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%+"
        ", XF86AudioLowerVolume, exec, wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-"
        ", XF86AudioMute, exec, wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle"
        
        # Brightness controls
        ", XF86MonBrightnessUp, exec, brightnessctl set +10%"
        ", XF86MonBrightnessDown, exec, brightnessctl set 10%-"
      ];
      
      # Mouse bindings
      bindm = [
        "$mod, mouse:272, movewindow"
        "$mod, mouse:273, resizewindow"
      ];
      
      # Window rules
      windowrule = [
        "float, ^(pavucontrol)$"
        "float, ^(nm-connection-editor)$"
        "float, ^(blueman-manager)$"
        "float, ^(org.gnome.Settings)$"
        "float, ^(org.gnome.design.Contrast)$"
        "float, ^(color-picker)$"
        "float, ^(Network)$"
        "float, ^(xdg-desktop-portal)$"
        "float, ^(xdg-desktop-portal-gnome)$"
        "float, ^(transmission-gtk)$"
        "opacity 0.80 0.80,^(ghostty)$"
        "opacity 0.80 0.80,^(code)$"
      ];
      
      # Workspace rules
      workspace = [
        "1, monitor:DP-1"
        "2, monitor:DP-1"
        "3, monitor:DP-1"
        "4, monitor:DP-1"
        "5, monitor:DP-1"
      ];
    };
  };
  
  # Additional packages for Hyprland
  home.packages = with pkgs; [
    # Wallpaper
    hyprpaper
    
    # Screenshot tools
    grim
    slurp
    
    # Application launcher
    wofi
    
    # Clipboard
    wl-clipboard
    
    # Brightness control
    brightnessctl
    
    # Audio control
    pwvucontrol
    
    # Network manager applet
    networkmanagerapplet
    
    # Bluetooth manager
    blueman
  ];
  
  # Hyprpaper configuration
  services.hyprpaper = {
    enable = true;
    settings = {
      ipc = "on";
      splash = false;
      splash_offset = 2.0;
      
      preload = [
        "~/.config/wallpaper.jpg"
      ];
      
      wallpaper = [
        ",~/.config/wallpaper.jpg"
      ];
    };
  };
}