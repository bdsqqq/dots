{ config
, pkgs
, lib
, modulesPath
, inputs
, ...
}:

let
  mbpPubKey = lib.removeSuffix "\n" (builtins.readFile ../../system/ssh-keys/mbp-m2.pub);
in {
  imports = (
    [
      ../../bundles/base.nix
      ../../bundles/headless.nix
      ../../bundles/dev.nix
      ../../system/vector.nix
    ]
  ) ++ lib.optionals (builtins.pathExists ./hardware-configuration.nix) [ ./hardware-configuration.nix ];

  networking.hostName = "htz-relay";
  networking.useDHCP = lib.mkDefault true;
  networking.networkmanager.enable = false;

  networking.firewall = {
    enable = true;
    allowPing = false;
    trustedInterfaces = [ "tailscale0" ];
    allowedTCPPorts = [ ];
    allowedUDPPorts = [ ];
    interfaces.tailscale0.allowedTCPPorts = [ 22000 8384 3923 ];
    interfaces.tailscale0.allowedUDPPorts = [ 22000 ];
    checkReversePath = "loose";
  };

  # ssh provided by base bundle

  # tailscale provided by base bundle; host-specific flags preserved
  services.tailscale = {
    enable = true;
    useRoutingFeatures = "client";
    extraUpFlags = [ "--ssh" "--accept-dns=false" ];
    authKeyFile = lib.mkIf (config.sops.secrets ? tailscale_auth_key) config.sops.secrets.tailscale_auth_key.path;
  };

  # copyparty file server
  services.copyparty = {
    enable = true;
    user = "bdsqqq";
    group = "users";
    settings = {
      i = "0.0.0.0";
      p = [ 3923 ];
      v = [ "/mnt/storage-01/commonplace:/commonplace:r" ]; # read-only for everyone (on tailscale)
      q = true; # quiet mode
    };
  };

  systemd.services.copyparty.serviceConfig.BindPaths = [ "/mnt/storage-01/commonplace" ];

  # syncthing provided by headless bundle; declarative mesh settings live here
  services.syncthing = {
    openDefaultPorts = false;
    guiAddress = "0.0.0.0:8384";
    settings = {
      gui = {
        user = "bdsqqq";
        password = "$2a$10$jGT.D5kEaNOxsNaCvrmfqukdEW5e9ugrXU/dR15oSAACbDEYIR5YO";
      };
      options = {
        urAccepted = -1;
        listenAddress = [
          "tcp://0.0.0.0:22000"
          "quic://0.0.0.0:22000"
        ];
        globalAnnounceEnabled = false;
        localAnnounceEnabled = false;
        relaysEnabled = false;
        natEnabled = false;
        maxSendKbps = 0;
        maxRecvKbps = 0;
        connectionLimitEnough = 0;
        connectionLimitMax = 0;
      };

      devices = {
        "mbp-m2" = {
          id = "6QPGO5Z-ZBZZVDW-MCYFBKB-MGZQO47-GITV6C5-5YGBXLT-VWHNAQ4-5XMKDAG";
          addresses = [
            "tcp://mbp-m2:22000"
            "quic://mbp-m2:22000"
          ];
          introducer = true;
        };

        ipd = {
          id = "YORN2Q5-DWT444V-65WLF77-JHDHP5X-HHZEEFO-NKTLTYZ-M777AXS-X2KX6AF";
          addresses = [
            "tcp://ipd:22000"
            "quic://ipd:22000"
          ];
        };

        iph16 = {
          id = "L2PJ4F3-BZUZ4RX-3BCPIYB-V544M22-P3WDZBF-ZEVYT5A-GPTX5ZF-ZM5KTQK";
          addresses = [
            "tcp://iph16:22000"
            "quic://iph16:22000"
          ];
        };
        
        r56 = {
          id = "JOWDMTJ-LQKWV6K-5V37UTD-EKJBBHS-3FJPKWD-HRONTJC-F4NZGJN-VKJTZAQ";
          addresses = [
            "tcp://r56:22000"
            "quic://r56:22000"
          ];
        };
      };

      folders = {
        commonplace = {
          enable = true;
          id = "sqz7z-a6tfg";
          label = "commonplace";
          path = "/mnt/storage-01/commonplace";
          type = "sendreceive";
          rescanIntervalS = 3600;
          devices = [ "mbp-m2" "ipd" "iph16" "r56" ];
          versioning = {
            type = "trashcan";
            params.cleanoutDays = "30";
          };
        };
      };
    };
  };

  systemd.tmpfiles.rules = [
    "d /mnt/storage-01/commonplace 0700 bdsqqq users -"
  ];

  users.users.bdsqqq = {
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    shell = pkgs.zsh;
    openssh.authorizedKeys.keys = [ mbpPubKey ];
    hashedPassword = "$6$LeozgmV9I6N0QYNf$3BeytD3X/gFNzBJAeWYqFPqD7m9Qz4gn8vORyFtrJopplmZ/pgLZzcktymHLU9CVbR.SkFPg9MAbYNKWLzvaT0";
  };

  security.sudo = {
    enable = true;
    wheelNeedsPassword = false;
  };

  programs.zsh.enable = true;

  # home-manager configuration
  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    extraSpecialArgs = { inherit inputs; isDarwin = false; hostSystem = "x86_64-linux"; headMode = "headless"; torchBackend = "cpu"; };
    users.bdsqqq = {
      home.username = "bdsqqq";
      home.homeDirectory = "/home/bdsqqq";
      home.stateVersion = "25.05";
      programs.home-manager.enable = true;
    };
  };

  time.timeZone = "Europe/London";
  i18n.defaultLocale = "en_US.UTF-8";

  boot.loader.grub = {
    enable = true;
    device = "/dev/sda";
  };

  environment.systemPackages = with pkgs; [
    git
    curl
    htop
    tree
  ];

  services.qemuGuest.enable = true;

  nixpkgs.config.allowUnfree = true;
  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";

  system.stateVersion = "25.05";
}



