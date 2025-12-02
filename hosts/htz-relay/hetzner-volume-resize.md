# Resizing a Hetzner Cloud Volume

after resizing a volume in the hetzner console, the host's filesystem must be expanded to use the new space. this guide covers ext4 volumes mounted on nixos.

## prerequisites

- volume already resized in hetzner cloud console
- ssh access to the host (e.g., `ssh htz-relay`)

## steps

### 1. verify current state

```bash
ssh htz-relay 'lsblk -f /dev/sdb && df -h /mnt/storage-01'
```

this shows the filesystem type (should be ext4) and current usage. the `Size` column in `df` output reflects what the filesystem currently sees—not the block device size.

### 2. confirm block device sees new size

```bash
ssh htz-relay 'sudo blockdev --getsize64 /dev/sdb | numfmt --to=iec'
```

if this shows the new size (hetzner may round up), proceed. if not, the console resize may not have propagated yet.

### 3. resize the filesystem

```bash
ssh htz-relay 'sudo resize2fs /dev/sdb'
```

ext4 supports online resizing—no unmount required. the command extends the filesystem to fill the block device.

### 4. verify

```bash
ssh htz-relay 'df -h /mnt/storage-01'
```

`Size` should now reflect the expanded volume.

## notes

- **data safety**: `resize2fs` only extends into unallocated space; existing data is not touched.
- **other filesystems**: xfs uses `xfs_growfs /mnt/storage-01` instead. btrfs uses `btrfs filesystem resize max /mnt/storage-01`.
- **if the volume won't resize**: ensure no processes are writing heavily; check `dmesg` for errors.

## references

- [hetzner cloud volumes docs](https://docs.hetzner.com/cloud/volumes/overview)
- `man resize2fs`
