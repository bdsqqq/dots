# hosts/mbp14.local/default.nix
# Enhanced host configuration with improved input handling
{ pkgs, inputs, systems ? [ ], pkgsFor ? null, ... }: {
  imports = [
    inputs.home-manager.darwinModules.home-manager
    ../../bundles/base.nix
    ../../bundles/desktop.nix
    ../../bundles/dev.nix
    ../../bundles/headless.nix
    ../../system/sops.nix
    ../../system/homebrew.nix
    ../../system/macos-defaults.nix
    ../../system/kanata.nix
    ../../system/syncthing-automerge.nix
    ../../system/code-server.nix
    ../../system/vector.nix
    ../../user/gaming.nix
  ];

  # home-manager module enabled at flake level; user-layer provided via bundles
  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    extraSpecialArgs = {
      inherit inputs systems pkgsFor;
      isDarwin = true;
      hostSystem = "aarch64-darwin";
      headMode = "graphical";
    };
    users.bdsqqq = { lib, pkgs, ... }: {
      home.username = "bdsqqq";
      home.homeDirectory = "/Users/bdsqqq";
      home.stateVersion = "25.05";
      programs.home-manager.enable = true;
      
      # declarative syncthing settings (daemon managed by launchd in system/syncthing.nix)
      services.syncthing = {
        enable = true;
        overrideFolders = true;
        overrideDevices = true;
        
        settings = {
          gui = {
            address = "0.0.0.0:8384";
            user = "bdsqqq";
            password = "$2a$10$jGT.D5kEaNOxsNaCvrmfqukdEW5e9ugrXU/dR15oSAACbDEYIR5YO";
          };
          options = {
            urAccepted = -1;
            globalAnnounceEnabled = false;
            localAnnounceEnabled = false;
            relaysEnabled = false;
            natEnabled = false;
          };
          
          devices = {
            "htz-relay" = {
              id = "HPMO7GH-P5UX4LC-OYSWWVP-XTMOUWL-QXUDAYH-ZJXXQDJ-QN677MY-QNQACQH";
              addresses = [ "tcp://htz-relay:22000" "quic://htz-relay:22000" ];
            };
            "r56" = {
              id = "JOWDMTJ-LQKWV6K-5V37UTD-EKJBBHS-3FJPKWD-HRONTJC-F4NZGJN-VKJTZAQ";
              addresses = [ "tcp://r56:22000" "quic://r56:22000" ];
            };
            "iph16" = {
              id = "L2PJ4F3-BZUZ4RX-3BCPIYB-V544M22-P3WDZBF-ZEVYT5A-GPTX5ZF-ZM5KTQK";
              addresses = [ "dynamic" ];
            };
            "ipd" = {
              id = "YORN2Q5-DWT444V-65WLF77-JHDHP5X-HHZEEFO-NKTLTYZ-M777AXS-X2KX6AF";
              addresses = [ "tcp://ipd:22000" "quic://ipd:22000" ];
            };
            "lgo-z2e" = {
              id = "4B7Q2Z5-SNAOQJO-S4L4FSG-IBBV5XH-67DUXTW-L3Z3JT7-CUQCWP6-TKHP5AG";
              addresses = [ "tcp://lgo-z2e:22000" "quic://lgo-z2e:22000" ];
            };
          };
          
          folders = {
            commonplace = {
              enable = true;
              id = "sqz7z-a6tfg";
              label = "commonplace";
              path = "/Users/bdsqqq/commonplace";
              type = "sendreceive";
              rescanIntervalS = 60;
              devices = [ "htz-relay" "r56" "iph16" "ipd" "lgo-z2e" ];
              versioning = {
                type = "trashcan";
                params.cleanoutDays = "0";
              };
            };

            prism-instances = {
              enable = true;
              id = "prism-instances";
              label = "PrismLauncher instances";
              path = "/Users/bdsqqq/Library/Application Support/PrismLauncher/instances";
              type = "sendreceive";
              rescanIntervalS = 120;
              devices = [ "r56" "lgo-z2e" ];
            };
          };
        };
      };
      
      # fix: home-manager syncthing doesn't set RunAtLoad, so manually override
      launchd.agents.syncthing.config.RunAtLoad = true;
      launchd.agents.syncthing-init.config.RunAtLoad = true;
    };
  };

  

  # Host-specific settings
  # System identification for multi-host setups
  networking = {
    hostName = "mbp-m2.local";     # FQDN is fine for HostName
    localHostName = "mbp-m2";      # must NOT contain dots (mDNS)
    computerName = "mbp-m2";       # UI name
  };

  # ensure darwin user exists with a concrete home path so HM can derive paths
  users.users.bdsqqq.home = "/Users/bdsqqq";
  system.primaryUser = "bdsqqq";

  # required by nix-darwin
  system.stateVersion = 6;

  # darwin baselines
  nixpkgs = {
    hostPlatform = "aarch64-darwin";
    config.allowUnfree = true;
  };

  # Kanata enabled when host imports system/kanata.nix
}
