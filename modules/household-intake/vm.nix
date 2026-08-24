{ hostPkgs
, lib
, ...
}:

{
  networking = {
    hostName = "household-storage";
    useDHCP = false;
    useNetworkd = true;
    firewall = {
      enable = true;
      interfaces.tailscale0.allowedTCPPorts = [ 22 ];
    };
  };

  systemd.network = {
    enable = true;
    networks."10-uplink" = {
      matchConfig.Name = "en*";
      networkConfig.DHCP = "yes";
    };
  };

  services = {
    openssh = {
      enable = true;
      settings = {
        KbdInteractiveAuthentication = false;
        PasswordAuthentication = false;
        PermitRootLogin = "no";
      };
    };
    tailscale.enable = true;
  };

  users.users.bdsqqq = {
    isNormalUser = true;
    extraGroups = [ "wheel" ];
  };
  security.sudo.wheelNeedsPassword = false;

  microvm = {
    hypervisor = "vfkit";
    vmHostPackages = hostPkgs;
    vcpu = 4;
    mem = 6144;
    storeOnDisk = true;
    interfaces = [
      {
        type = "user";
        id = "nat";
        mac = "02:00:00:42:00:01";
      }
    ];
    volumes = [
      {
        image = "/var/lib/household-intake/vm/state.img";
        mountPoint = "/var";
        size = 8192;
        fsType = "ext4";
      }
    ];
    socket = "household-storage.sock";
  };

  system.stateVersion = "26.05";
}
