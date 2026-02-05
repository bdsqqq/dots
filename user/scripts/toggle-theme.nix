{ pkgs }:

# toggle-theme script with proper environment setup for hyprland/nixos
# gsettings requires DBUS_SESSION_BUS_ADDRESS and XDG_DATA_DIRS to work
# from contexts without full session environment (like hyprland's exec)
pkgs.writeShellScriptBin "toggle-theme" ''
  export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
  export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}''${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}"
  current=$(${pkgs.glib}/bin/gsettings get org.gnome.desktop.interface color-scheme)
  if [ "$current" = "'prefer-dark'" ]; then
    ${pkgs.glib}/bin/gsettings set org.gnome.desktop.interface color-scheme prefer-light
  else
    ${pkgs.glib}/bin/gsettings set org.gnome.desktop.interface color-scheme prefer-dark
  fi
''
