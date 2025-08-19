# Desktop Menubar Vision & Implementation Plan

## User Intent & Design Philosophy

### The Vision
Create a **clean, minimal desktop environment** with a macOS-style menubar experience:
- **Minimal waybar** with only essential icons (no clutter)
- **Anchored popovers** that appear when clicking icons (not separate windows)
- **Interactive terminals** embedded in popup scratchpads (btop, system monitoring)
- **Persistent popups** that stay alive when hidden (no restart lag)
- **Consistent interaction model** across all desktop elements

### Current Problems
1. **Broken waybar bluetooth scripts** - using `systemctl` checks that don't work properly
2. **Mixed launcher inconsistency** - fuzzel vs networkmanager_dmenu vs blueman-manager
3. **No system monitoring** - missing CPU/memory/temperature widgets
4. **Custom scripts everywhere** - fighting waybar's native capabilities
5. **No popup anchoring** - separate windows clutter the desktop
6. **Dead niri references** - unused code throughout configuration

## Technical Research Findings

### Waybar Native Modules vs Custom Scripts
- **Native bluetooth module** (`"bluetooth": { format = "󰂯 {status}"; }`) is more reliable than shell scripts
- **Built-in system monitoring** (cpu, memory, temperature) updates properly without custom polling
- **Consistent styling** integrates seamlessly with waybar theming
- **Lower resource usage** compared to external script polling

### EWW Widget Limitations
- **Cannot embed interactive terminals** - only static text widgets supported
- **No proper terminal integration** - feature requested but not implemented
- **Alternative needed** for interactive popup content

### Hyprland + Pyprland Solution
#### Hyprland Scratchpads (Special Workspaces)
- **Persistent terminals** that stay alive when hidden
- **Toggle show/hide** with single command
- **Position anywhere** on screen with window rules
- **Keep processes running** between visibility toggles

#### Pyprland Enhancements
- **Proper anchoring** to screen positions relative to waybar
- **Smooth animations** (slide from top/bottom/left/right) 
- **Auto-hide on focus loss** when clicking elsewhere
- **Size/position preservation** per monitor
- **Multiple scratchpads** for different tools (btop, audio controls, etc.)

## Implementation Architecture

### Waybar Configuration
```nix
# Clean, minimal modules using native waybar widgets
modules-right = [ 
  "cpu"           # Native CPU monitoring
  "memory"        # Native memory usage  
  "temperature"   # Native temp monitoring
  "bluetooth"     # Native BT module (not custom script)
  "pulseaudio"    # Native audio control
  "network"       # Native network status
  "clock"         # Time display
];

# System monitor popup
"cpu" = {
  format = "󰻠 {usage}%";
  on-click = "pypr toggle btop-popup";  # Toggle scratchpad
};

# Native bluetooth (replaces custom scripts)
"bluetooth" = {
  format = "󰂯 {status}";
  format-connected = "󰂯 {num_connections}";
  on-click = "pypr toggle bluetooth-popup";
};
```

### Pyprland Scratchpad Configuration
```json
{
  "btop-popup": {
    "command": "ghostty --class=btop-popup --title='System Monitor' -e btop",
    "animation": "fromTop",
    "margin": 50,
    "unfocus": "hide",
    "position": "0 40"  // Anchored below waybar
  },
  
  "bluetooth-manager": {
    "command": "ghostty --class=bt-popup --title='Bluetooth' -e bluetoothctl",
    "animation": "fromTop", 
    "margin": 200,
    "unfocus": "hide",
    "position": "800 40"
  },
  
  "audio-mixer": {
    "command": "ghostty --class=audio-popup --title='Audio' -e pulsemixer",
    "animation": "fromTop",
    "margin": 150, 
    "unfocus": "hide",
    "position": "600 40"
  }
}
```

### Hyprland Window Rules
```nix
# Scratchpad terminal styling
windowrulev2 = float, class:(btop-popup)
windowrulev2 = workspace special:btop silent, class:(btop-popup)
windowrulev2 = size 800 500, class:(btop-popup)

windowrulev2 = float, class:(bt-popup) 
windowrulev2 = workspace special:bluetooth silent, class:(bt-popup)
windowrulev2 = size 600 400, class:(bt-popup)

windowrulev2 = float, class:(audio-popup)
windowrulev2 = workspace special:audio silent, class:(audio-popup) 
windowrulev2 = size 500 300, class:(audio-popup)
```

## User Experience Flow

1. **Click CPU icon** → btop terminal slides down from top, anchored below waybar
2. **Click bluetooth icon** → bluetooth manager terminal appears as popup
3. **Click audio icon** → audio mixer/device selector popup appears
4. **Click elsewhere** → popups auto-hide but processes stay alive
5. **Click same icon again** → instant toggle (no restart lag)

## Implementation Priority

### Phase 1: Foundation (High Priority)
1. **Add pyprland to system packages**
2. **Replace custom bluetooth scripts with native waybar bluetooth module** 
3. **Add native CPU/memory/temperature widgets to waybar**
4. **Create basic pyprland configuration file**

### Phase 2: Scratchpad Setup (Medium Priority)  
5. **Configure btop system monitor scratchpad**
6. **Set up bluetooth manager popup terminal**
7. **Create audio device switcher scratchpad** 
8. **Add hyprland window rules for popup positioning**

### Phase 3: Polish & Cleanup (Lower Priority)
9. **Remove all dead niri references from flake.nix and configs**
10. **Standardize launcher choice (fuzzel) across all remaining interactions**
11. **Test popup positioning on different screen sizes**
12. **Fine-tune animations and auto-hide behavior**

## Benefits of This Approach

- **Clean Desktop** - no floating windows cluttering workspace
- **Fast Interaction** - terminals stay alive, instant show/hide
- **Consistent UX** - all controls accessed via menubar popovers  
- **Resource Efficient** - native waybar modules + persistent terminals
- **Maintainable** - declarative nix configuration, no fragile shell scripts
- **Extensible** - easy to add new scratchpad tools as needed

## Notes for Implementation

- **Test bluetooth thoroughly** - main current pain point
- **Verify ghostty terminal integration** with pyprland scratchpads
- **Check waybar positioning** calculations for popup anchoring
- **Monitor resource usage** with new native widgets
- **Ensure consistent theming** across scratchpad terminals
- **Keep backup of working config** during transition