{ pkgs }:

# toggle-theme script with proper environment setup for niri/NixOS.
# gsettings is the closest thing Linux desktops have to a shared light/dark
# preference; Qt/Kvantum and older GTK themes still need explicit bridges.
pkgs.writeShellScriptBin "toggle-theme" ''
  set -euo pipefail

  export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
  export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}''${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}"

  schema="org.gnome.desktop.interface"
  current="$(${pkgs.glib}/bin/gsettings get "$schema" color-scheme)"

  if [ "$current" = "'prefer-dark'" ]; then
    next="prefer-light"
    mode="light"
    gtk_theme="adw-gtk3"
    kvantum_theme="KvRoughGlass"
  else
    next="prefer-dark"
    mode="dark"
    gtk_theme="adw-gtk3-dark"
    kvantum_theme="EInkGlass"
  fi

  ${pkgs.glib}/bin/gsettings set "$schema" color-scheme "$next"
  ${pkgs.glib}/bin/gsettings set "$schema" gtk-theme "$gtk_theme"

  mkdir -p "$HOME/.config/Kvantum" "''${XDG_STATE_HOME:-$HOME/.local/state}"
  rm -f "$HOME/.config/Kvantum/kvantum.kvconfig"
  cat > "$HOME/.config/Kvantum/kvantum.kvconfig" <<EOF
[General]
theme=$kvantum_theme
EOF
  printf '%s\n' "$mode" > "''${XDG_STATE_HOME:-$HOME/.local/state}/theme-mode"

  printf '%s\n' "$next"
''

