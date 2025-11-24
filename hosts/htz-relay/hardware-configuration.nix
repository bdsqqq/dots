{ modulesPath, ... }:
{
  imports = [ (modulesPath + "/profiles/qemu-guest.nix") ];
  boot.loader.grub.device = "/dev/sda";
  boot.initrd.availableKernelModules = [ "ata_piix" "uhci_hcd" "xen_blkfront" "vmw_pvscsi" ];
  boot.initrd.kernelModules = [ "nvme" ];
  fileSystems."/" = { device = "/dev/sda1"; fsType = "ext4"; };

  fileSystems."/mnt/storage-01" = {
    device = "/dev/disk/by-id/scsi-0HC_Volume_104047902";
    fsType = "ext4";
    options = [ "discard" "defaults" "nofail" ];
  };
  
}
