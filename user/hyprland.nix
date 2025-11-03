{ pkgs, lib, hostSystem ? null, ... }:

if !(lib.hasInfix "linux" hostSystem) then {} else {
  wayland.windowManager.hyprland = {
    enable = true;
    package = pkgs.hyprland;
    
    settings = {
      # Monitor configuration
      monitor = [ ",preferred,auto,1" ];
      
      # Environment variables for cursor theme (NVIDIA vars provided by system/nvidia.nix)
      env = [
        # Cursor theme (traditional macOS-style)
        "HYPRCURSOR_THEME,macOS"
        "HYPRCURSOR_SIZE,24"
        "XCURSOR_THEME,macOS"
        "XCURSOR_SIZE,24"
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
        "blueman-applet"
        "pypr"  # Start pyprland for scratchpad management
        # Cursor theme setup (ensures proper application)
        "hyprctl setcursor macOS 24"
        "gsettings set org.gnome.desktop.interface cursor-theme 'macOS'"
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
        
        # Resize behavior
        resize_on_border = true;
        extend_border_grab_area = 15;
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
      "$hyper" = "SUPER SHIFT CTRL ALT";

      bind = [
        # macOS-style window layout shortcuts (Hyper = Super + Shift + Ctrl + Alt)
        "$hyper, H, exec, hyprctl dispatch togglefloating active off && hyprctl dispatch movewindow l"  # Tile left
        "$hyper, J, exec, hyprctl dispatch togglefloating active on && hyprctl dispatch resizewindowpixel exact 60% 60% && hyprctl dispatch centerwindow"  # Float 60% centered
        "$hyper, K, exec, hyprctl dispatch togglefloating active on && hyprctl dispatch resizewindowpixel exact 95% 95% && hyprctl dispatch centerwindow"  # Float full size centered
        "$hyper, L, exec, hyprctl dispatch togglefloating active off && hyprctl dispatch movewindow r"  # Tile right
        
        # macOS-style application management
        "$mod, Q, killactive"  # Quit application (like Cmd+Q)
        
        "$hyper, V, togglefloating"
        "$hyper, C, togglesplit"
        
        # Meta-launcher (fuzzel-based command palette)  
        "$mod, SPACE, exec, /home/bdsqqq/commonplace/01_files/scripts/fuzzel-launcher"
        
        "$mod, A, exec, hyprctl dispatch focusurgentorlast"  # Select all / focus urgent
        
        # Movement
        "$mod, left, movefocus, l"
        "$mod, right, movefocus, r"
        "$mod, up, movefocus, u"
        "$mod, down, movefocus, d"
        
        # Resize mode keybindings
        "$hyper, R, submap, resize"
        
        # Window resizing with keyboard
        "$mod SHIFT, left, resizeactive, -50 0"
        "$mod SHIFT, right, resizeactive, 50 0"
        "$mod SHIFT, up, resizeactive, 0 -50"
        "$mod SHIFT, down, resizeactive, 0 50"
        
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
        
        # Fix keybinds after rebuild
        "$hyper, R, exec, sudo systemctl restart kanata-default.service"
      ];
      
      # Resize submap for visual feedback during resizing
      submap = [
        "resize,left,resizeactive,-50 0"
        "resize,right,resizeactive,50 0"
        "resize,up,resizeactive,0 -50"
        "resize,down,resizeactive,0 50"
        "resize,escape,submap,reset"
        "resize,return,submap,reset"
      ];
      
      # Mouse bindings
      bindm = [
        "$mod, mouse:272, movewindow"
        "$mod, mouse:273, resizewindow"
      ];
      
      # Window rules using correct v2 syntax
      windowrulev2 = [
        # System control windows
        "float, class:^(pavucontrol)$"
        "float, class:^(nm-connection-editor)$"
        "float, class:^(blueman-manager)$"
        
        # Meta-launcher floating terminal
        "float, class:^(meta-launcher)$"
        "size 60% 70%, class:^(meta-launcher)$"
        "center, class:^(meta-launcher)$"
        "animation popin 80%, class:^(meta-launcher)$"
        "rounding 10, class:^(meta-launcher)$"
        "dimaround, class:^(meta-launcher)$"
        
        # Make fuzzel float properly
        "float, class:^(fuzzel)$"
        "center, class:^(fuzzel)$"
        "dimaround, class:^(fuzzel)$"
        
        # Pyprland scratchpad windows
        # System monitoring with btop
        "float, class:^(btop-popup)$"
        "workspace special:btop silent, class:^(btop-popup)$"
        "size 60% 70%, class:^(btop-popup)$"
        "center, class:^(btop-popup)$"
        
        # Bluetooth management
        "float, class:^(bluetuith-popup)$"
        "workspace special:bluetooth silent, class:^(bluetuith-popup)$"
        "size 50% 60%, class:^(bluetuith-popup)$"
        "center, class:^(bluetuith-popup)$"
        
        # Audio control
        "float, class:^(audio-popup)$"
        "workspace special:audio silent, class:^(audio-popup)$"
        "size 40% 50%, class:^(audio-popup)$"
        "center, class:^(audio-popup)$"
        
        # Network management
        "float, class:^(network-popup)$"
        "workspace special:network silent, class:^(network-popup)$"
        "size 50% 60%, class:^(network-popup)$"
        "center, class:^(network-popup)$"
        
        # System logs
        "float, class:^(logs-popup)$"
        "workspace special:logs silent, class:^(logs-popup)$"
        "size 70% 80%, class:^(logs-popup)$"
        "center, class:^(logs-popup)$"
        
        # System management
        "float, class:^(system-popup)$"
        "workspace special:system silent, class:^(system-popup)$"
        "size 60% 70%, class:^(system-popup)$"
        "center, class:^(system-popup)$"
        
        # Network bandwidth monitoring
        "float, class:^(bandwidth-popup)$"
        "workspace special:bandwidth silent, class:^(bandwidth-popup)$"
        "size 50% 60%, class:^(bandwidth-popup)$"
        "center, class:^(bandwidth-popup)$"
        
        # Disk I/O monitoring
        "float, class:^(disk-popup)$"
        "workspace special:disk silent, class:^(disk-popup)$"
        "size 60% 70%, class:^(disk-popup)$"
        "center, class:^(disk-popup)$"
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
