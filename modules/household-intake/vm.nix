{ config
, hostPkgs
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
    # microvm.nix defaults to a stdio console, but vfkit requires stdin to be
    # a TTY in that mode. launchd has no TTY, so keep the console file-backed.
    declaredRunner = config.microvm.runner.vfkit.overrideAttrs (old: {
      buildCommand = old.buildCommand + ''
        runner=$(readlink $out/bin/microvm-run)
        rm $out/bin/microvm-run
        cp "$runner" $out/bin/microvm-run
        substituteInPlace $out/bin/microvm-run \
          --replace-fail 'virtio-serial,stdio' 'virtio-serial,logFilePath=guest-console.log'
      '';
    });
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
        image = "state.img";
        mountPoint = "/var";
        size = 8192;
        fsType = "ext4";
      }
    ];
    socket = "household-storage.sock";
  };

  system.stateVersion = "26.05";
}
