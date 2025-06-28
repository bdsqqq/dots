# NixOS Installation Guide for Windows PC Dual Boot

## Overview
This guide covers installing NixOS with niri window manager alongside Windows 11 on your PC with the following specs:
- CPU: AMD Ryzen 5 5600G (12 threads)
- GPU: NVIDIA GeForce RTX 3060 + AMD Radeon integrated graphics
- RAM: 16GB
- Storage: 256GB SSD (C:) + 1TB HDD (D:)
- Display: LG HDR 4K 3840x2160 @ 60Hz

## Current Status
✅ NixOS configuration created with niri window manager
✅ Hardware-specific modules configured
✅ NVIDIA drivers configured
✅ 4K display scaling configured (1.5x = effective 2560x1440)
✅ ISO build configuration created

## Building the ISO

### On macOS (current)
```bash
# Build the ISO (this will take a while)
nix build .#nixosConfigurations.windows-pc-iso.config.system.build.isoImage

# The ISO will be in: result/iso/
```

### Alternative: Build on Linux
If the build fails on macOS, you can:
1. Use a Linux VM or machine
2. Clone this repository there
3. Run the same build command

## Installation Steps

### 1. Prepare Windows
1. **Shrink Windows partition** (recommended: 100-150GB for NixOS)
   - Open Disk Management in Windows
   - Right-click C: drive → Shrink Volume
   - Enter amount to shrink (100000 MB = ~100GB)

2. **Disable Fast Startup** (important for dual boot)
   - Control Panel → Power Options → Choose what power buttons do
   - Click "Change settings that are currently unavailable"
   - Uncheck "Turn on fast startup"

3. **Note your EFI partition**
   - In Disk Management, look for the 100MB "EFI System Partition"
   - Note which disk it's on

### 2. Create Installation Media
1. Write the ISO to a USB drive (8GB+):
   ```bash
   # On macOS
   sudo dd if=result/iso/nixos-*.iso of=/dev/diskN bs=4M status=progress
   
   # On Linux
   sudo dd if=result/iso/nixos-*.iso of=/dev/sdX bs=4M status=progress conv=fsync
   ```

### 3. Boot and Install
1. **Boot from USB**
   - Enter BIOS/UEFI (usually F2, Del, or F12 during boot)
   - Disable Secure Boot (if enabled)
   - Set USB as first boot device

2. **Test niri in Live Environment**
   - The installer includes niri
   - Login as root (password: nixos)
   - Test with: `niri-session`

3. **Partition the Drive**
   ```bash
   # List disks
   lsblk
   
   # Open partition manager
   sudo gparted
   ```
   
   Create:
   - NO new EFI partition (use Windows' existing one)
   - 100-150GB ext4 partition for NixOS root (/)
   - 8-16GB swap partition (optional but recommended)
   - Rest can stay unallocated or create /home partition

4. **Mount Partitions**
   ```bash
   # Mount root
   sudo mount /dev/nvmeXnYpZ /mnt  # Replace with your root partition
   
   # Mount existing Windows EFI partition
   sudo mkdir -p /mnt/boot
   sudo mount /dev/nvmeXnYpA /mnt/boot  # Replace with EFI partition
   
   # If you created swap
   sudo swapon /dev/nvmeXnYpB  # Replace with swap partition
   ```

5. **Generate Hardware Configuration**
   ```bash
   sudo nixos-generate-config --root /mnt
   ```

6. **Copy Configuration**
   ```bash
   # The ISO includes our configuration
   sudo cp /nixos-config/configuration.nix /mnt/etc/nixos/
   
   # Or clone from git
   cd /mnt/etc/nixos
   sudo git clone https://github.com/YOUR_REPO/nix-darwin.git
   sudo cp nix-darwin/hosts/windows-pc/default.nix configuration.nix
   ```

7. **Update Hardware Configuration**
   Edit `/mnt/etc/nixos/hardware-configuration.nix`:
   - Verify the generated UUIDs match your partitions
   - Ensure the EFI mount point is correct

8. **Install NixOS**
   ```bash
   sudo nixos-install
   ```

9. **Set Root Password**
   When prompted, set a root password

10. **Reboot**
    ```bash
    sudo reboot
    ```

### 4. Post-Installation

1. **Verify Dual Boot**
   - You should see GRUB menu with NixOS and Windows options
   - Windows should be auto-detected

2. **First Login**
   - Login as root
   - Create your user: `passwd bdsqqq`
   - Switch to niri: logout and select niri session

3. **Apply Full Configuration**
   ```bash
   # As your user
   cd /etc/nixos
   sudo nixos-rebuild switch --flake .#windows-pc
   ```

4. **NVIDIA Driver Check**
   ```bash
   nvidia-smi  # Should show your RTX 3060
   ```

5. **4K Scaling Check**
   - Applications should be scaled 1.5x
   - If not, check waybar and application scaling

## Troubleshooting

### GRUB doesn't show Windows
```bash
sudo os-prober  # Should detect Windows
sudo nixos-rebuild switch  # Regenerate GRUB config
```

### NVIDIA Issues
- Check kernel modules: `lsmod | grep nvidia`
- Check logs: `journalctl -b | grep nvidia`
- Try different driver version in configuration

### 4K Scaling Issues
- Qt apps: Check QT_SCALE_FACTOR environment variable
- GTK apps: Check GDK_SCALE environment variable
- Cursor too small: Verify XCURSOR_SIZE=48

### niri Won't Start
- Check logs: `journalctl --user -u niri`
- Try starting manually: `niri-session`
- Verify NVIDIA environment variables are set

## Maintenance

### Updates
```bash
# Update flake inputs
nix flake update

# Rebuild system
sudo nixos-rebuild switch --flake .#windows-pc
```

### Switching Between Windows and NixOS
- Use GRUB menu at boot
- Or set default in BIOS/UEFI boot order

## Notes
- Windows time may be wrong after booting NixOS (UTC vs local time issue)
  Fix: `timedatectl set-local-rtc 1` in NixOS
- Keep Windows EFI partition backed up
- Test kernel updates carefully (NVIDIA compatibility)