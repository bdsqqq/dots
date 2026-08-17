# hosts/mbp14.local/default.nix
# Enhanced host configuration with improved input handling
{
  lib,
  pkgs,
  inputs,
  systems ? [ ],
  pkgsFor ? null,
  ...
}:
let
  syncthing = import ../../modules/syncthing.nix { inherit lib; };
in
{
  imports = [
    inputs.home-manager.darwinModules.home-manager

    # Shared system infrastructure
    ../../modules/primary-user.nix
    ../../system/nix.nix
    ../../system/nh.nix
    ../../system/nix-ld.nix
    ../../system/ssh.nix
    ../../system/tailscale.nix
    ../../system/tailnet-registry.nix
    ../../system/sops.nix
    ../../system/authorized-keys.nix
    ../../system/fonts.nix
    ../../system/auto-upgrade.nix
    ../../system/syncthing.nix
    ../../system/audio.nix
    ../../system/bluetooth.nix
    ../../system/flatpak.nix
    ../../system/homebrew.nix
    ../../system/homebrew-best-effort.nix
    ../../system/macos-defaults.nix
    ../../system/sleepless.nix
    ../../system/kanata.nix
    ../../system/cmux.nix
    ./moshi-host.nix

    # Configured user programs
    ../../user/shell-baseline.nix
    ../../user/node-pnpm
    ../../user/mise.nix
    ../../user/syncthing-automerge
    ../../user/wikiman.nix
    ../../user/yt-dlp.nix
    ../../user/gallery-dl.nix
    ../../user/rust.nix
    ../../user/go.nix
    ../../user/fairy-name.nix
    ../../user/pi
    ../../user/pi-memory.nix
    ../../user/e-ink-glass.nix
    ../../user/ghostty.nix
    ../../user/vscodium
    ../../user/1password.nix
    ../../user/orbstack.nix
    ../../user/obs
    ../../user/helium-remotes.nix
    ../../user/gaming.nix
  ];

  homebrew = {
    casks = [
      # System utilities
      "cleanshot"
      "tailscale-app"

      # Development tools
      "tableplus"

      # Creative/Media tools
      "figma"
      "obs"
      "transmission"

      # Productivity applications
      "linear"
      "vscodium"

      # Entertainment/Gaming
      "steam"
    ];
  };

  # Home Manager module is enabled at flake level.
  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    extraSpecialArgs = {
      inherit inputs systems pkgsFor;
      isDarwin = true;
      hostSystem = "aarch64-darwin";
      headMode = "graphical";
    };
    users.bdsqqq =
      {
        lib,
        pkgs,
        config,
        ...
      }:
      {
        home.username = "bdsqqq";
        home.homeDirectory = "/Users/bdsqqq";
        home.stateVersion = "25.05";
        programs.home-manager.enable = true;

        # Unconfigured host-selected programs
        home.packages = with pkgs; [
          coreutils
          exiftool
          sops
          age
          ssh-to-age
          pscale
          ripgrep
          ast-grep
          fd
          bat
          eza
          ctop
          lazydocker
          curl
          wget
          jq
          yq
          tree
          p7zip
          cloc
          stow
          yazi
          tmux
          ffmpeg
          httpie
          fastfetch
          mkcert
          istat-menus
          libimobiledevice
          ifuse
          blockbench
          vscode
          obsidian
          rclone
          qpdf
          inputs.lnr.packages.aarch64-darwin.default
          axiom-cli
          iina
          ollama
          lua-language-server
          stylua
          typescript
          typescript-language-server
          nil
          nixfmt
          statix
        ];

        home.activation.kindleLibrary = lib.hm.dag.entryBetween [ "linkGeneration" ] [ "writeBoundary" ] ''
          mkdir -p ${lib.escapeShellArg "${config.home.homeDirectory}/kindle/one piece"}
        '';
        home.file."commonplace/01_files/kindle".source =
          config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/kindle";

        # declarative syncthing settings (daemon managed by launchd in system/syncthing.nix)
        services.syncthing = {
          enable = true;
          overrideFolders = true;
          overrideDevices = true;
          # use guiAddress (not settings.gui.address) - home-manager's init script
          # PATCHes guiAddress after PUTting settings.gui, so settings.gui.address gets overwritten
          guiAddress = "0.0.0.0:8384";

          settings = {
            gui = {
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

            devices = syncthing.devicesFor [
              "htz-relay"
              "lgo-z2e"
              "mmn-m4"
              "iph16"
              "ipd"
              "kindle"
            ];

            folders = {
              commonplace = syncthing.folderFor "commonplace" config.home.homeDirectory true [
                "htz-relay"
                "lgo-z2e"
                "mmn-m4"
                "iph16"
                "ipd"
              ] { label = "commonplace"; };
              pi-sessions = syncthing.folderFor "pi-sessions" config.home.homeDirectory true [ "lgo-z2e" ] { };
              helium-remotes = syncthing.folderFor "helium-remotes" config.home.homeDirectory true [
                "htz-relay"
                "lgo-z2e"
              ] { };
              kindle = syncthing.folderFor "kindle" config.home.homeDirectory true [ "kindle" ] { };
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
    hostName = "mbp-m2.local";
    localHostName = "mbp-m2";
    computerName = "mbp-m2";
  };

  users.users.bdsqqq.home = "/Users/bdsqqq";
  system.primaryUser = "bdsqqq";
  my.primaryUser = "bdsqqq";
  my.tailnetRegistry.hostChecks.syncthing = {
    enable = true;
    configFile = "/Users/bdsqqq/Library/Application Support/Syncthing/config.xml";
    folderIds = [ syncthing.folderIds.commonplace ];
  };
  my.tailnetRegistry.services.syncthing = {
    title = "syncthing";
    description = "mbp-m2 synchronization status";
    target = "http://127.0.0.1:8384";
    scheme = "https";
    port = 8385;
    healthPath = "/";
    access.tailnet = "owner";
  };
  my.heliumRemotes = {
    enable = true;
    tabsExtension.enable = true;
  };

  system.stateVersion = 6;
  nixpkgs = {
    hostPlatform = "aarch64-darwin";
    config.allowUnfree = true;
  };
}
