# lgo-z2e installation guide

## boot from USB

login: `nixos` / `nixos`

## partition disk

```bash
sudo parted /dev/nvme0n1 -- mklabel gpt
sudo parted /dev/nvme0n1 -- mkpart ESP fat32 1MB 512MB
sudo parted /dev/nvme0n1 -- set 1 esp on
sudo parted /dev/nvme0n1 -- mkpart primary ext4 512MB 100%
sudo mkfs.fat -F 32 -n BOOT /dev/nvme0n1p1
sudo mkfs.ext4 -L nixos /dev/nvme0n1p2
```

## mount and install

```bash
sudo mount /dev/disk/by-label/nixos /mnt
sudo mkdir -p /mnt/boot
sudo mount /dev/disk/by-label/BOOT /mnt/boot
sudo nixos-generate-config --root /mnt
sudo nixos-install --flake github:bdsqqq/dots#lgo-z2e
```

## after install

1. copy UUIDs from `/mnt/etc/nixos/hardware-configuration.nix`
2. update `hosts/lgo-z2e/hardware.nix` with real UUIDs
3. commit and push changes
4. reboot into installed system

ssh is enabled on the installer - can push changes from device or pull from r56.
