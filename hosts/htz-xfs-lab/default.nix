{
  inputs,
  lib,
  modulesPath,
  pkgs,
  ...
}:

let
  operatorKey = lib.removeSuffix "\n" (builtins.readFile ../../modules/ssh/keys/mbp-m2.pub);
  initializeVdo = pkgs.writeShellApplication {
    name = "initialize-xfs-vdo";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.gnugrep
      pkgs.lvm2_vdo
      pkgs.util-linux
      pkgs.vdo
      pkgs.xfsprogs
    ];
    text = ''
      if [[ $# -ne 1 || ! $1 =~ ^[0-9]+$ ]]; then
        echo "usage: initialize-xfs-vdo HETZNER_VOLUME_ID" >&2
        exit 2
      fi

      device="/dev/disk/by-id/scsi-0HC_Volume_$1"
      if [[ ! -b "$device" ]]; then
        echo "expected Hetzner volume is not a block device: $device" >&2
        exit 1
      fi

      if pvs --noheadings -o vg_name "$device" 2>/dev/null | grep -q 'xfs_vdo_lab'; then
        echo "xfs_vdo_lab already owns $device"
        exit 0
      fi

      if [[ -n "$(wipefs --noheadings "$device")" ]]; then
        echo "refusing to overwrite a non-empty device: $device" >&2
        exit 1
      fi

      pvcreate "$device"
      vgcreate xfs_vdo_lab "$device"
      lvcreate \
        --type vdo \
        --name data \
        --size 45G \
        --virtualsize 100G \
        xfs_vdo_lab
      mkfs.xfs -K -L xfs-vdo-lab /dev/xfs_vdo_lab/data
      systemctl start mnt-xfs\\x2dvdo.mount
    '';
  };
in
{
  imports = [
    (modulesPath + "/profiles/qemu-guest.nix")
    ../../modules/primary-user.nix
    ../../modules/nix
    ../../modules/nix/nix-ld.nix
    ../../modules/tailscale
    ../../modules/tailnet-registry
    ../../modules/core-cli
    ../../modules/shell
    ../../modules/btop
    ../../modules/fzf
    ../../modules/zoxide
    ../../modules/nvim
    ../../modules/git
    ../../modules/tealdeer
    ../../modules/trash
    (import ../../modules/zmx).module
    ../../modules/direnv
    ../../modules/tmux
    ../../modules/amp
    ../../modules/agents
    ../../modules/node-pnpm
    ../../modules/mise
    ../../modules/rust
    ../../modules/go
    ../../modules/fairy-name
    ../../modules/pi
    ../../modules/pi-memory
    ../../modules/t3-code/server.nix
  ];

  nixpkgs.hostPlatform = "x86_64-linux";

  my.primaryUser = "bdsqqq";
  my.paths.commonplace = "/home/bdsqqq/commonplace";

  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    users.bdsqqq = {
      home = {
        stateVersion = "26.11";
        packages = with pkgs; [
          age
          hcloud
          inputs.lnr.packages.x86_64-linux.default
          lua-language-server
          nil
          nixfmt
          opentofu
          pscale
          sops
          ssh-to-age
          statix
          stylua
          typescript
          typescript-language-server
        ];
      };
      programs.home-manager.enable = true;
    };
  };

  networking = {
    hostName = "htz-xfs-lab";
    useDHCP = lib.mkDefault true;
    firewall.allowedTCPPorts = [ 22 ];
  };

  boot = {
    initrd.availableKernelModules = [
      "ata_piix"
      "sd_mod"
      "sr_mod"
      "virtio_pci"
      "virtio_scsi"
    ];
    kernelModules = [ "dm-vdo" ];
  };

  disko.devices.disk.root = {
    type = "disk";
    device = "/dev/sda";
    content = {
      type = "gpt";
      partitions = {
        bios = {
          size = "1M";
          type = "EF02";
        };
        root = {
          size = "100%";
          content = {
            type = "filesystem";
            format = "ext4";
            mountpoint = "/";
          };
        };
      };
    };
  };

  fileSystems."/mnt/xfs-vdo" = {
    device = "/dev/disk/by-label/xfs-vdo-lab";
    fsType = "xfs";
    options = [
      "defaults"
      "nofail"
      "x-systemd.device-timeout=10s"
    ];
  };

  services.openssh = {
    enable = true;
    settings = {
      KbdInteractiveAuthentication = false;
      PasswordAuthentication = false;
      PermitRootLogin = "prohibit-password";
    };
  };
  services.lvm = {
    dmeventd.enable = true;
    boot.vdo.enable = true;
  };

  users.users = {
    root.openssh.authorizedKeys.keys = [ operatorKey ];
    bdsqqq = {
      isNormalUser = true;
      extraGroups = [ "wheel" ];
      openssh.authorizedKeys.keys = [ operatorKey ];
    };
  };
  security.sudo.wheelNeedsPassword = false;

  environment.systemPackages = [
    pkgs.fio
    pkgs.lvm2_vdo
    pkgs.vdo
    pkgs.xfsprogs
    initializeVdo
  ];

  system.stateVersion = "26.11";
}
