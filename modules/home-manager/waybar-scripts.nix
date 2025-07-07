# Simple waybar scripts 
{ config, pkgs, lib, ... }:

let
  # Bluetooth status script
  bluetoothScript = pkgs.writeShellScript "bluetooth-status" ''
    #!/bin/bash
    
    if ! systemctl is-active --quiet bluetooth; then
        echo "󰂲"
        exit 0
    fi
    
    if bluetoothctl show | grep -q "Powered: yes"; then
        connected=$(bluetoothctl devices Connected | wc -l)
        if [ "$connected" -gt 0 ]; then
            echo "󰂯"
        else
            echo "󰂯"
        fi
    else
        echo "󰂲"
    fi
  '';

  # Bluetooth toggle script
  bluetoothToggleScript = pkgs.writeShellScript "bluetooth-toggle" ''
    #!/bin/bash
    
    if bluetoothctl show | grep -q "Powered: yes"; then
        bluetoothctl power off
        notify-send -i bluetooth "Bluetooth" "Disabled" -t 2000
    else
        bluetoothctl power on
        notify-send -i bluetooth "Bluetooth" "Enabled" -t 2000
    fi
  '';

  # Bluetooth device menu script
  bluetoothMenuScript = pkgs.writeShellScript "bluetooth-menu" ''
    #!/bin/bash
    
    # Get available devices
    devices=$(bluetoothctl devices | while read -r line; do
        mac=$(echo "$line" | cut -d' ' -f2)
        name=$(echo "$line" | cut -d' ' -f3-)
        
        # Check if connected
        if bluetoothctl info "$mac" | grep -q "Connected: yes"; then
            echo "󰂱 $name (Connected)|disconnect $mac"
        else
            echo "󰂯 $name|connect $mac"
        fi
    done)
    
    # Add scan and power options
    menu_items="󰑐 Scan for devices|scan
    󰏪 Power off|power off
    $devices"
    
    # Show menu with fuzzel
    selected=$(echo "$menu_items" | fuzzel --dmenu --prompt "Bluetooth: " --lines 10)
    
    if [ -n "$selected" ]; then
        action=$(echo "$selected" | cut -d'|' -f2)
        
        case "$action" in
            "scan")
                bluetoothctl scan on &
                sleep 5
                bluetoothctl scan off
                notify-send -i bluetooth "Bluetooth" "Scan complete" -t 2000
                ;;
            "power off")
                bluetoothctl power off
                notify-send -i bluetooth "Bluetooth" "Powered off" -t 2000
                ;;
            "connect "*)
                mac=$(echo "$action" | cut -d' ' -f2)
                bluetoothctl connect "$mac"
                ;;
            "disconnect "*)
                mac=$(echo "$action" | cut -d' ' -f2)
                bluetoothctl disconnect "$mac"
                ;;
        esac
    fi
  '';

  # Audio output menu script
  audioMenuScript = pkgs.writeShellScript "audio-menu" ''
    #!/bin/bash
    
    # Get available sinks
    sinks=$(wpctl status | grep -A 50 "Audio" | grep -E "^\s*[0-9]+" | grep -v "Stream" | while read -r line; do
        id=$(echo "$line" | grep -o '[0-9]*' | head -1)
        name=$(echo "$line" | sed 's/^[^*]*[*]*[[:space:]]*[0-9]*\.[[:space:]]*//')
        
        # Check if default
        if echo "$line" | grep -q '\*'; then
            echo "󰓃 $name (Default)|$id"
        else
            echo "󰓃 $name|$id"
        fi
    done)
    
    # Show menu
    selected=$(echo "$sinks" | fuzzel --dmenu --prompt "Audio Output: " --lines 8)
    
    if [ -n "$selected" ]; then
        sink_id=$(echo "$selected" | cut -d'|' -f2)
        wpctl set-default "$sink_id"
        device_name=$(echo "$selected" | cut -d'|' -f1 | sed 's/^[^[:space:]]*[[:space:]]*//')
        notify-send -i audio-volume-high "Audio" "Switched to: $device_name" -t 2000
    fi
  '';

  # Notification status script (for mako)
  notificationScript = pkgs.writeShellScript "notification-status" ''
    #!/bin/bash
    
    if ! pgrep -x "mako" > /dev/null; then
        echo "󰂚"
        exit 0
    fi
    
    count=$(makoctl list | jq '.data[0] | length' 2>/dev/null || echo "0")
    
    if [ "$count" -gt 0 ]; then
        echo "󰂚"
    else
        echo "󰂚"
    fi
  '';

in
{
  # Create the scripts directory and files
  home.file = {
    ".config/waybar/scripts/bluetooth.sh" = {
      source = bluetoothScript;
      executable = true;
    };
    
    ".config/waybar/scripts/bluetooth-toggle.sh" = {
      source = bluetoothToggleScript;
      executable = true;
    };
    
    ".config/waybar/scripts/bluetooth-menu.sh" = {
      source = bluetoothMenuScript;
      executable = true;
    };
    
    ".config/waybar/scripts/audio-menu.sh" = {
      source = audioMenuScript;
      executable = true;
    };
    
    ".config/waybar/scripts/notifications.sh" = {
      source = notificationScript;
      executable = true;
    };
  };
}