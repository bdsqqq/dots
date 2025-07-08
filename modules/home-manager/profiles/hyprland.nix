{ config, pkgs, lib, inputs, ... }:

{
  wayland.windowManager.hyprland = {
    enable = true;
    package = inputs.hyprland.packages.${pkgs.system}.hyprland;
    
    settings = {
      # Monitor configuration
      monitor = [ ",preferred,auto,1" ];
      
      # Environment variables for NVIDIA and cursor theme
      env = [
        # Cursor theme (2024-2025 best practice)
        "HYPRCURSOR_THEME,Bibata-Modern-Classic"
        "HYPRCURSOR_SIZE,24"
        "XCURSOR_THEME,Bibata-Modern-Classic"
        "XCURSOR_SIZE,24"
        # NVIDIA
        "LIBVA_DRIVER_NAME,nvidia"
        "XDG_SESSION_TYPE,wayland"
        "GBM_BACKEND,nvidia-drm"
        "__GLX_VENDOR_LIBRARY_NAME,nvidia"
        "WLR_NO_HARDWARE_CURSORS,1"
      ];
      
      # Cursor configuration (2024-2025 best practice)
      cursor = {
        enable_hyprcursor = true;
      };
      
      # Startup applications
      exec-once = [
        "waybar"
        "mako"
        "nm-applet"
        # Cursor theme setup (ensures proper application)
        "hyprctl setcursor Bibata-Modern-Classic 24"
        "gsettings set org.gnome.desktop.interface cursor-theme 'Bibata-Modern-Classic'"
        "gsettings set org.gnome.desktop.interface cursor-size 24"
      ];
      
      # Input configuration
      input = {
        kb_layout = "us";
        follow_mouse = 1;
        sensitivity = 0;
      };
      
      # General settings
      general = {
        gaps_in = 5;
        gaps_out = 20;
        border_size = 2;
        layout = "dwindle";
      };
      
      # Decoration settings with working syntax
      decoration = {
        rounding = 10;
        active_opacity = lib.mkForce 0.65;
        inactive_opacity = lib.mkForce 0.65;
        
        blur = {
          enabled = true;
          size = 8;
          passes = 1;
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
          "fade, 1, 7, default"
          "workspaces, 1, 6, default"
        ];
      };
      
      # Layout settings
      dwindle = {
        pseudotile = true;
        preserve_split = true;
      };
      
      # Key bindings
      "$mod" = "SUPER";
      
      bind = [
        # Basic shortcuts
        "$mod, Q, exec, ghostty"
        "$mod, C, killactive"
        "$mod, M, exit"
        "$mod, E, exec, nautilus"
        "$mod, V, togglefloating"
        "$mod, R, exec, wofi --show drun"
        "$mod, J, togglesplit"
        
        # Movement
        "$mod, left, movefocus, l"
        "$mod, right, movefocus, r"
        "$mod, up, movefocus, u"
        "$mod, down, movefocus, d"
        
        # Workspaces
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
        
        # Move to workspaces
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
        
        # Screenshots
        ", Print, exec, grim -g \"$(slurp)\" - | wl-copy"
        "SHIFT, Print, exec, grim - | wl-copy"
        
        # Media keys
        ", XF86AudioRaiseVolume, exec, wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%+"
        ", XF86AudioLowerVolume, exec, wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-"
        ", XF86AudioMute, exec, wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle"
      ];
      
      # Mouse bindings
      bindm = [
        "$mod, mouse:272, movewindow"
        "$mod, mouse:273, resizewindow"
      ];
      
      # Window rules using correct v2 syntax
      windowrulev2 = [
        "float, class:^(pavucontrol)$"
        "float, class:^(nm-connection-editor)$"
        "float, class:^(blueman-manager)$"
      ];
    };
  };
  
  # Essential packages
  home.packages = with pkgs; [
    grim
    slurp
    wofi
    wl-clipboard
    networkmanagerapplet
    blueman
  ];
}