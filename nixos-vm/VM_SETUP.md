# NixOS VM Setup

This directory contains a complete NixOS VM configuration with niri window manager and development tools. The VM is designed to provide a full Linux development environment using the user's existing dotfiles.

## Quick Start

```bash
cd nixos-vm
./run-vm.sh run
```

## Requirements

- Nix with flakes enabled
- QEMU (automatically installed if missing)
- 8GB+ available RAM (default configuration)
- Hardware acceleration support (KVM) for best performance
- **x86_64-linux system** or remote builder for cross-platform builds

### Cross-Platform Building

**Apple Silicon Macs**: This VM targets x86_64-linux. You'll need either:
1. A remote Linux builder configured in Nix
2. An x86_64-linux system to build on
3. Use emulation (much slower): `--system x86_64-linux`

## Commands

### Build VM
```bash
./run-vm.sh build
```
Builds the VM without running it.

### Run VM
```bash
./run-vm.sh run
```
Builds and starts the VM with default settings.

### Clean Up
```bash
./run-vm.sh clean
```
Removes build artifacts and cleans up storage.

### Run Tests
```bash
./smoke-test.sh
```
Validates the configuration without building.

## VM Specifications

- **RAM:** 8GB (configurable)
- **CPU:** 4 cores (configurable)
- **Graphics:** VirtIO with OpenGL acceleration
- **Network:** NAT with SSH forwarding on port 2222
- **Storage:** Dynamic disk allocation

## Customization

### Memory and CPU
```bash
QEMU_OPTS="-m 12288 -smp 6" ./run-vm.sh run
```

### Different Display Backend
```bash
QEMU_OPTS="-display sdl" ./run-vm.sh run
```

### Enable VNC Access
```bash
QEMU_OPTS="-vnc :1" ./run-vm.sh run
```

## VM Access

### SSH Access
```bash
ssh -p 2222 bdsqqq@localhost
```
Password authentication is enabled for convenience.

### Direct Console
Use the QEMU window or press `Ctrl+Alt+2` for QEMU monitor.

### Graphics
- Press `Ctrl+Alt+G` to release mouse capture
- Press `Ctrl+Alt+F` to toggle fullscreen

## What's Included

### Window Manager
- **niri** - Scrollable-tiling Wayland compositor
- **waybar** - Status bar
- **fuzzel** - Application launcher
- **mako** - Notification daemon

### Development Tools
- **Git** with user configuration
- **Zsh** with configuration from dotfiles
- **Development packages** from home-manager modules

### Applications
- **Firefox** (Wayland-enabled)
- **Alacritty** terminal
- **Nautilus** file manager

### System Tools
- **PipeWire** audio
- **NetworkManager** networking
- **Docker** containerization
- **Essential utilities**

## Keyboard Shortcuts (niri)

- **Mod+T** - Open terminal (Alacritty)
- **Mod+D** - Open application launcher (fuzzel)
- **Mod+Q** - Close window
- **Mod+Left/Right** - Navigate between columns
- **Mod+Up/Down** - Navigate between windows
- **Mod+1-5** - Switch workspaces
- **Mod+Ctrl+1-5** - Move window to workspace
- **Mod+L** - Lock screen
- **Print** - Take screenshot

## Troubleshooting

### VM Won't Start
1. Check QEMU installation: `which qemu-system-x86_64`
2. Verify KVM access: `ls -la /dev/kvm`
3. Try without KVM: `QEMU_OPTS="-accel tcg" ./run-vm.sh run`

### Performance Issues
1. Enable KVM if available
2. Increase RAM: `QEMU_OPTS="-m 12288" ./run-vm.sh run`
3. Add more CPU cores: `QEMU_OPTS="-smp 6" ./run-vm.sh run`

### Graphics Problems
1. Try different display backend: `QEMU_OPTS="-display sdl" ./run-vm.sh run`
2. Disable OpenGL: `QEMU_OPTS="-display gtk,gl=off" ./run-vm.sh run`

### SSH Connection Refused
1. Wait for VM to fully boot (check QEMU console)
2. Verify port forwarding: `netstat -tlnp | grep 2222`
3. Check VM networking: `ping -c1 localhost`

### Build Failures
1. Run smoke tests: `./smoke-test.sh`
2. Clean and rebuild: `./run-vm.sh clean && ./run-vm.sh build`
3. Check Nix configuration: `nix flake check`

## Integration with Dotfiles

The VM uses existing modules from the parent dotfiles repository:
- `../modules/home-manager/development.nix` - Development tools
- `../modules/home-manager/shell.nix` - Shell configuration

To modify VM-specific settings, edit:
- `configuration.nix` - System-level configuration
- `home.nix` - User-level configuration
- `hardware.nix` - Hardware and virtualization settings

## Performance Tips

### Host System
- Enable KVM: Requires virtualization support and `/dev/kvm` access
- Use SSD storage for best I/O performance
- Close unnecessary applications to free RAM

### VM Configuration
- Increase RAM for development workloads
- Enable CPU pinning for CPU-intensive tasks
- Use host CPU model: `QEMU_OPTS="-cpu host"`

### Guest System
- The VM includes automatic optimization for QEMU
- VirtIO drivers are pre-configured
- Memory ballooning is enabled for dynamic allocation

## Security Notes

- SSH password authentication is enabled for development convenience
- Sudo doesn't require password for wheel group users
- Firewall allows SSH (port 22) by default
- Consider these settings for production environments

## Development Workflow

1. **Start VM**: `./run-vm.sh run`
2. **SSH in**: `ssh -p 2222 bdsqqq@localhost`
3. **Develop normally** using familiar tools and configuration
4. **Test changes** in isolated environment
5. **Snapshot VM state** using QEMU snapshots if needed

## File Sharing

To share files between host and VM:
- Use SSH/SCP: `scp -P 2222 file.txt bdsqqq@localhost:`
- Mount shared directories via QEMU (advanced)
- Use network file sharing (NFS/SMB)

## Next Steps

- Customize the niri configuration in `home.nix`
- Add project-specific development tools
- Set up additional services (databases, etc.)
- Configure automatic dotfiles synchronization
- Create VM snapshots for different development environments
