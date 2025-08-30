# Debugging Pypl Daemon Issue

## Quick Fix Commands

```bash
# Check if pyprland service is running
systemctl --user status pyprland

# Check pyprland logs
journalctl --user -u pyprland -f

# Check if pypr binary exists
which pypr

# Check pyprland config
cat ~/.config/pypr/pyprland.toml

# Restart pyprland service
systemctl --user restart pyprland

# Check if waybar can communicate with pypr
pypr toggle system-popup
```

## Common Issues & Solutions

### 1. Service Not Starting
```bash
# Enable and start service
systemctl --user enable pyprland
systemctl --user start pyprland
```

### 2. Missing Config File
```bash
# Check if config exists
ls -la ~/.config/pypr/

# If missing, rebuild NixOS
sudo nixos-rebuild switch
```

### 3. Permission Issues
```bash
# Check user groups
groups

# Ensure user is in audio, video, input groups
```

### 4. Test Individual Commands
```bash
# Test pyprland directly
pypr toggle btop-popup

# Test TUI apps individually
ghostty --class=btop-popup -e btop
```

## Quick Debug Steps

1. **Check service status**: `systemctl --user status pyprland`
2. **Check logs**: `journalctl --user -u pyprland -f`
3. **Test pypr command**: `pypr toggle system-popup`
4. **Check config**: `cat ~/.config/pypr/pyprland.toml`
5. **Restart service**: `systemctl --user restart pyprland`

## If Still Broken

```bash
# Full system restart
sudo nixos-rebuild boot
sudo reboot

# Or check systemd user session
loginctl show-user $USER
```