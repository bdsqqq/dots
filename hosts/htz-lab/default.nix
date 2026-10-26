{
  config,
  inputs,
  lib,
  modulesPath,
  pkgs,
  ...
}:
let
  operatorKey = lib.removeSuffix "\n" (builtins.readFile ../../modules/ssh/keys/mbp-m2.pub);
  checkout = "${config.my.paths.commonplace}/01_files/nix";
  gitAsUser = "${pkgs.util-linux}/bin/runuser -u bdsqqq -- ${pkgs.git}/bin/git -C ${checkout}";
in
{
  # Independent agent host: no VDO volume, bind mounts, or identities inherited
  # from htz-xfs-lab. Its existing workloads must remain independently usable.
  imports = [
    (modulesPath + "/profiles/qemu-guest.nix")
    ../../modules/primary-user.nix
    ../../modules/agent-decoy
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
    ../../modules/agents
    ../../modules/gog
    ../../modules/wacli
    ../../modules/goplaces
    ../../modules/openhue
    ../../modules/xurl
    ../../modules/weather
    ../../modules/remindctl
    ../../modules/node-pnpm
    ../../modules/mise
    ../../modules/rust
    ../../modules/go
    ../../modules/fairy-name
    ../../modules/pi
    ../../modules/t3-code/server.nix
  ];

  nixpkgs.hostPlatform = "x86_64-linux";
  my.primaryUser = "bdsqqq";
  my.paths.commonplace = "/home/bdsqqq/commonplace";
  my.t3Code.nativeService.enable = true;

  # Install the CLI, but don't transfer the old runner's Google authorization.
  my.gog.enable = false;

  networking = {
    hostName = "htz-lab";
    useDHCP = lib.mkDefault true;
    firewall.allowedTCPPorts = [ 22 ];
  };

  sops = {
    age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];
    secrets.tailscale_auth_key = {
      sopsFile = ../../tailscale/secrets/machines/htz-lab.yaml;
      key = "authKey";
      mode = "0400";
    };
  };
  services.tailscale = {
    authKeyFile = config.sops.secrets.tailscale_auth_key.path;
    extraUpFlags = [
      "--ssh=false"
      "--operator=bdsqqq"
    ];
    extraSetFlags = [ "--operator=bdsqqq" ];
  };

  users.groups.users.gid = 100;
  users.users = {
    root.openssh.authorizedKeys.keys = [ operatorKey ];
    bdsqqq = {
      uid = 1000;
      isNormalUser = true;
      shell = pkgs.zsh;
      extraGroups = [ "wheel" ];
      openssh.authorizedKeys.keys = [ operatorKey ];
    };
  };
  security.sudo.wheelNeedsPassword = false;
  services.openssh = {
    enable = true;
    settings = {
      KbdInteractiveAuthentication = false;
      PasswordAuthentication = false;
      PermitRootLogin = "prohibit-password";
    };
  };

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

  boot.initrd.availableKernelModules = [
    "ata_piix"
    "sd_mod"
    "sr_mod"
    "virtio_pci"
    "virtio_scsi"
  ];
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
  swapDevices = [
    {
      device = "/swapfile";
      size = 4096;
    }
  ];

  nix.settings = {
    keep-outputs = lib.mkForce false;
    keep-derivations = lib.mkForce false;
    min-free = 4 * 1024 * 1024 * 1024;
    max-free = 8 * 1024 * 1024 * 1024;
  };
  nix.gc.options = "--delete-old";
  system.autoUpgrade.runGarbageCollection = true;

  # The OS updater alone doesn't refresh editable, out-of-store program sources.
  # Git refuses conflicting/diverged work; Home Manager reapplies dependency
  # installation/builds even when only live source, not its derivation, changed.
  systemd.services.nixos-upgrade.after = [ "home-manager-bdsqqq.service" ];
  systemd.services.nixos-upgrade.serviceConfig = {
    ExecStartPre = [
      "${gitAsUser} fetch origin main"
      "${gitAsUser} -c merge.autoStash=false merge --ff-only origin/main"
    ];
    ExecStartPost = [ "${pkgs.systemd}/bin/systemctl restart home-manager-bdsqqq.service" ];
  };
  system.stateVersion = "26.11";
}
