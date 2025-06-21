# NixOS VM with niri Window Manager

Complete NixOS VM configuration integrating your existing home-manager modules with the niri tiling Wayland compositor.

## Quick Start

### Build and Test VM

```bash
# Build the configuration
cd nixos-vm
nix build .#nixosConfigurations.nixos-vm.config.system.build.vm

# Run the VM (8GB RAM, 4 cores)
QEMU_OPTS="-m 8192 -smp 4 -enable-kvm" ./result/bin/run-nixos-vm

# Alternative: Run with more memory and better graphics
QEMU_OPTS="-m 12288 -smp 6 -enable-kvm -vga virtio" ./result/bin/run-nixos-vm
```

### Installation to Real Hardware

```bash
# Build installer ISO
nix build .#nixosConfigurations.nixos-vm.config.system.build.isoImage

# Or install directly (adjust disk paths)
sudo nixos-install --flake .#nixos-vm --root /mnt
```

## Configuration Features

### Core System
- **Window Manager**: niri (Scrollable tiling Wayland compositor)
- **Login Manager**: greetd with tuigreet
- **Audio**: PipeWire with ALSA/PulseAudio compatibility
- **Display**: Wayland with XDG portals for screen sharing

### Development Environment
- **Editor**: Neovim with LSP, Telescope, Avante AI assistant
- **Shell**: Zsh with Oh My Zsh and custom Vercel theme
- **Languages**: Python 3.12, Go, Node.js (via fnm), Rust tools
- **Tools**: Git, Docker, development CLI utilities

### Wayland Ecosystem
- **App Launcher**: Fuzzel
- **Status Bar**: Waybar  
- **Notifications**: Mako
- **Screen Lock**: Swaylock with swayidle
- **Screenshots**: Grim + Slurp
- **Clipboard**: wl-clipboard

### Key Bindings (niri)
- `Super + T` - Terminal (Alacritty)
- `Super + D` - App launcher (Fuzzel)  
- `Super + Q` - Close window
- `Super + Arrow Keys` - Navigate windows
- `Super + Ctrl + Arrow Keys` - Move windows
- `Super + 1-5` - Switch workspaces
- `Super + Ctrl + 1-5` - Move window to workspace
- `Super + L` - Lock screen
- `Print` - Screenshot selection

## VM Optimizations

### Performance
- KVM acceleration enabled
- VM guest tools (QEMU guest agent, SPICE)
- Hardware acceleration for graphics
- Automatic store optimization

### Development Friendly
- Passwordless sudo (VM only)
- SSH enabled with password auth
- Docker and virtualization ready
- All development tools pre-installed

## Customization

### Adding Applications
Edit `nixos-vm/home.nix` and add packages to `home.packages`:

```nix
home.packages = with pkgs; [
  # Add your applications here
  discord
  slack
  # ...
];
```

### Modifying niri Config
Edit the `wayland.windowManager.niri.settings` section in `home.nix` to customize:
- Key bindings
- Layout settings  
- Window rules
- Workspace behavior

### System Services
Add system-level services in `nixos-vm/configuration.nix`:

```nix
services.your-service = {
  enable = true;
  # configuration...
};
```

## Integration with Existing Dotfiles

This configuration imports your existing home-manager modules:
- `../modules/home-manager/development.nix` - Development tools and environment
- `../modules/home-manager/shell.nix` - Zsh configuration
- `../modules/home-manager/neovim.nix` - Complete Neovim setup

### SOPS Secrets (Optional)
Uncomment the SOPS configuration in `configuration.nix` if you want to use encrypted secrets:

```nix
sops = {
  defaultSopsFile = ../secrets.yaml;
  # ... rest of config
};
```

## Troubleshooting

### VM Won't Start
- Ensure KVM is available: `lsmod | grep kvm`
- Try without KVM: Remove `-enable-kvm` from QEMU_OPTS
- Increase memory if needed: `-m 16384`

### Graphics Issues
- Try different QEMU graphics: `-vga qxl` or `-vga std`
- Enable software rendering: Set `WLR_RENDERER=pixman`

### Wayland Not Working
- Check if running in VM: `echo $XDG_SESSION_TYPE`
- Force Wayland: `export XDG_SESSION_TYPE=wayland`
- Check niri status: `systemctl --user status niri`

### Network Issues
- VM networking: Ensure DHCP is working
- Real hardware: Configure NetworkManager

## Development Workflow

1. **Make changes** to configuration files
2. **Test in VM**: `nix build .#nixosConfigurations.nixos-vm.config.system.build.vm`
3. **Deploy to real hardware**: `sudo nixos-rebuild switch --flake .#nixos-vm`

## Next Steps

- [ ] Add more GUI applications as needed
- [ ] Configure additional window manager settings
- [ ] Set up development-specific services
- [ ] Customize waybar appearance
- [ ] Add display configuration for multi-monitor setups
