# Waybar scripts for enhanced widgets
{ config, pkgs, lib, ... }:

let
  # Bluetooth status script
  bluetoothScript = pkgs.writeShellScript "bluetooth-status" ''
    #!/bin/bash
    
    # Check if bluetooth is enabled
    if ! systemctl is-active --quiet bluetooth; then
        echo '{"text": "󰂲", "class": "disabled", "tooltip": "Bluetooth disabled"}'
        exit 0
    fi
    
    # Check bluetooth status
    if bluetoothctl show | grep -q "Powered: yes"; then
        # Check for connected devices
        connected=$(bluetoothctl devices Connected | wc -l)
        if [ "$connected" -gt 0 ]; then
            # Get device names
            devices=$(bluetoothctl devices Connected | cut -d' ' -f3- | tr '\n' ', ' | sed 's/, $//')
            echo "{\"text\": \"󰂯\", \"class\": \"connected\", \"tooltip\": \"Connected: $devices\"}"
        else
            echo '{"text": "󰂯", "class": "disconnected", "tooltip": "Bluetooth on, no devices connected"}'
        fi
    else
        echo '{"text": "󰂲", "class": "disabled", "tooltip": "Bluetooth disabled"}'
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
    
    # Check if mako is running
    if ! pgrep -x "mako" > /dev/null; then
        echo '{"text": "󰂚", "class": "disabled", "tooltip": "Notifications disabled"}'
        exit 0
    fi
    
    # Get notification count from mako
    count=$(makoctl list | jq '.data[0] | length' 2>/dev/null || echo "0")
    
    if [ "$count" -gt 0 ]; then
        echo "{\"text\": \"󰂚 $count\", \"class\": \"has-notifications\", \"tooltip\": \"$count notifications\"}"
    else
        echo '{"text": "󰂚", "class": "empty", "tooltip": "No notifications"}'
    fi
  '';

  # System monitor script
  systemMonitorScript = pkgs.writeShellScript "system-monitor" ''
    #!/bin/bash
    
    # Get CPU usage
    cpu_usage=$(top -bn1 | grep "Cpu(s)" | sed "s/.*, *\([0-9.]*\)%* id.*/\1/" | awk '{print 100 - $1}')
    cpu_usage_int=$(printf "%.0f" "$cpu_usage")
    
    # Get memory usage
    mem_info=$(free | grep Mem)
    mem_total=$(echo $mem_info | awk '{print $2}')
    mem_used=$(echo $mem_info | awk '{print $3}')
    mem_usage=$(awk "BEGIN {printf \"%.0f\", $mem_used/$mem_total*100}")
    
    # Get temperature (try different sources)
    temp="--"
    if [ -f /sys/class/thermal/thermal_zone0/temp ]; then
        temp_raw=$(cat /sys/class/thermal/thermal_zone0/temp)
        temp=$(($temp_raw / 1000))
    elif command -v sensors >/dev/null 2>&1; then
        temp=$(sensors 2>/dev/null | grep -oP 'Package id 0:\s+\+\K[0-9]+' | head -1)
        [ -z "$temp" ] && temp=$(sensors 2>/dev/null | grep -oP 'Core 0:\s+\+\K[0-9]+' | head -1)
    fi
    
    # Determine class based on usage
    class="normal"
    if [ "$cpu_usage_int" -gt 80 ] || [ "$mem_usage" -gt 80 ]; then
        class="high-usage"
    fi
    
    # Format output
    if [ "$temp" != "--" ]; then
        text="󰍛 $cpu_usage_int% 󰘚 $mem_usage% 󰔏 $temp°C"
        tooltip="CPU: $cpu_usage_int% | Memory: $mem_usage% | Temperature: $temp°C"
    else
        text="󰍛 $cpu_usage_int% 󰘚 $mem_usage%"
        tooltip="CPU: $cpu_usage_int% | Memory: $mem_usage%"
    fi
    
    echo "{\"text\": \"$text\", \"class\": \"$class\", \"tooltip\": \"$tooltip\"}"
  '';

  # System details script
  systemDetailsScript = pkgs.writeShellScript "system-details" ''
    #!/bin/bash
    
    # Get detailed system information
    uptime_info=$(uptime -p)
    load_avg=$(uptime | grep -o "load average:.*" | cut -d' ' -f3- | sed 's/,//g')
    
    # CPU info
    cpu_model=$(grep "model name" /proc/cpuinfo | head -1 | cut -d':' -f2 | sed 's/^ *//')
    cpu_cores=$(nproc)
    
    # Memory info
    mem_info=$(free -h | grep Mem)
    mem_total=$(echo $mem_info | awk '{print $2}')
    mem_used=$(echo $mem_info | awk '{print $3}')
    mem_free=$(echo $mem_info | awk '{print $4}')
    
    # Disk info
    disk_info=$(df -h / | tail -1)
    disk_used=$(echo $disk_info | awk '{print $3}')
    disk_total=$(echo $disk_info | awk '{print $2}')
    disk_percent=$(echo $disk_info | awk '{print $5}')
    
    # Create detailed info
    details="System Information
    
    Uptime: $uptime_info
    Load Average: $load_avg
    
    CPU: $cpu_model
    Cores: $cpu_cores
    
    Memory: $mem_used / $mem_total ($mem_free free)
    
    Disk: $disk_used / $disk_total ($disk_percent used)"
    
    # Show in terminal or notification
    if command -v fuzzel >/dev/null 2>&1; then
        echo "$details" | fuzzel --dmenu --prompt "System Info: " --lines 12 --no-actions
    else
        notify-send -i computer "System Information" "$details" -t 10000
    fi
  '';

  # Power menu script
  powerMenuScript = pkgs.writeShellScript "power-menu" ''
    #!/bin/bash
    
    # Power menu options
    options="⏻ Shutdown
    ⏾ Reboot
    ⏯ Suspend
    ⏸ Lock
    ⏹ Logout
    ⏺ Hibernate"
    
    # Show menu
    selected=$(echo "$options" | fuzzel --dmenu --prompt "Power: " --lines 6)
    
    case "$selected" in
        "⏻ Shutdown")
            systemctl poweroff
            ;;
        "⏾ Reboot")
            systemctl reboot
            ;;
        "⏯ Suspend")
            systemctl suspend
            ;;
        "⏸ Lock")
            # Try different lock commands
            if command -v swaylock >/dev/null 2>&1; then
                swaylock -f
            elif command -v gtklock >/dev/null 2>&1; then
                gtklock -d
            else
                notify-send "Lock" "No lock screen available" -t 3000
            fi
            ;;
        "⏹ Logout")
            # Logout from niri
            niri msg action quit
            ;;
        "⏺ Hibernate")
            systemctl hibernate
            ;;
    esac
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
    
    ".config/waybar/scripts/system-monitor.sh" = {
      source = systemMonitorScript;
      executable = true;
    };
    
    ".config/waybar/scripts/system-details.sh" = {
      source = systemDetailsScript;
      executable = true;
    };
    
    ".config/waybar/scripts/power-menu.sh" = {
      source = powerMenuScript;
      executable = true;
    };
  };
}