{ pkgs, lib, hostSystem ? null, ... }:

let
  toggleTheme = pkgs.writeShellScriptBin "toggle-theme" ''
    export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
    export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}''${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}"
    current=$(${pkgs.glib}/bin/gsettings get org.gnome.desktop.interface color-scheme)
    if [ "$current" = "'prefer-dark'" ]; then
      ${pkgs.glib}/bin/gsettings set org.gnome.desktop.interface color-scheme prefer-light
    else
      ${pkgs.glib}/bin/gsettings set org.gnome.desktop.interface color-scheme prefer-dark
    fi
  '';
in

if !(lib.hasInfix "linux" hostSystem) then {} else {
  wayland.windowManager.hyprland = {
    enable = true;
    package = pkgs.hyprland;
    

    
    settings = {
      monitor = [ ",preferred,auto,1.5" ];
      
      env = [
        "HYPRCURSOR_THEME,macOS"
        "HYPRCURSOR_SIZE,24"
        "XCURSOR_THEME,macOS"
        "XCURSOR_SIZE,24"
        # wayland/electron font rendering
        "ELECTRON_OZONE_PLATFORM_HINT,wayland"
        "GDK_SCALE,1"
        "GDK_DPI_SCALE,1.5"
        "QT_QPA_PLATFORM,wayland"
        "QT_AUTO_SCREEN_SCALE_FACTOR,1"
      ];
      
      cursor = {
        enable_hyprcursor = true;
      };
      
      exec-once = [
        "swaybg -i /etc/wallpaper.jpg -m fill"
        "hyprctl setcursor macOS 24"
        "vicinae server"
        "waybar"
      ];
      
      layerrule = [
        "blur, vicinae"
        "ignorealpha 0, vicinae"
        "noanim, vicinae"
      ];
      
      input = {
        kb_layout = "us";
        follow_mouse = 1;
        sensitivity = 0;
      };
      
      general = {
        gaps_in = 4;
        gaps_out = 8;
        border_size = 0;
        "col.active_border" = "rgba(00000000)";
        "col.inactive_border" = "rgba(00000000)";
        layout = "dwindle";
        resize_on_border = true;
      };
      
      decoration = {
        rounding = 8;
        blur.enabled = false;
      };
      
      animations = {
        enabled = true;
        
        # ease-out-quint: responsive, user-initiated feel
        bezier = [
          "easeOutQuint, 0.23, 1, 0.32, 1"
          "easeInOutQuart, 0.77, 0, 0.175, 1"
        ];
        
        animation = [
          # windows: ease-out, ~150ms - responsive for open/close
          "windows, 1, 3, easeOutQuint, popin 80%"
          # fade: quick, subtle
          "fade, 1, 2, easeOutQuint"
          # workspaces: ease-in-out, adds weight to the movement
          "workspaces, 1, 3, easeInOutQuart, slide"
        ];
      };
      
      dwindle = {
        pseudotile = true;
        preserve_split = true;
      };
      
      "$mod" = "SUPER";

      bind = [
        "$mod, Q, killactive"
        "$mod, Return, exec, ghostty"
        "$mod, Space, exec, vicinae toggle"
        "$mod, T, exec, ${toggleTheme}/bin/toggle-theme"
        
        "$mod, V, togglefloating"
        "$mod, F, fullscreen"
        
        "$mod, left, movefocus, l"
        "$mod, right, movefocus, r"
        "$mod, up, movefocus, u"
        "$mod, down, movefocus, d"
        "$mod, H, movefocus, l"
        "$mod, L, movefocus, r"
        "$mod, K, movefocus, u"
        "$mod, J, movefocus, d"
        
        "$mod SHIFT, left, movewindow, l"
        "$mod SHIFT, right, movewindow, r"
        "$mod SHIFT, up, movewindow, u"
        "$mod SHIFT, down, movewindow, d"
        "$mod SHIFT, H, movewindow, l"
        "$mod SHIFT, L, movewindow, r"
        "$mod SHIFT, K, movewindow, u"
        "$mod SHIFT, J, movewindow, d"
        
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
        
        ", XF86AudioRaiseVolume, exec, wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%+"
        ", XF86AudioLowerVolume, exec, wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-"
        ", XF86AudioMute, exec, wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle"
      ];
      
      bindm = [
        "$mod, mouse:272, movewindow"
        "$mod, mouse:273, resizewindow"
      ];
    };
  };
  
  home.packages = with pkgs; [
    swaybg
    wl-clipboard
    glib  # provides gsettings, gdbus for theme toggling
    xdg-desktop-portal-gtk  # must be in same search path as hyprland portal
    toggleTheme
  ];
  
  # dconf settings for portal theme detection (portal-gtk reads these)
  dconf.enable = true;
  dconf.settings = {
    "org/gnome/desktop/interface" = {
      color-scheme = "prefer-dark";
      cursor-theme = "macOS";
      cursor-size = 24;
    };
  };
}
