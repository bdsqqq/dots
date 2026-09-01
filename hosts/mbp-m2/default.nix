# hosts/mbp14.local/default.nix
# Enhanced host configuration with improved input handling
{ lib
, pkgs
, inputs
, systems ? [ ]
, pkgsFor ? null
, ...
}:
let
  syncthing = import ../../modules/syncthing/lib.nix { inherit lib; };
in
{
  imports = [
    inputs.home-manager.darwinModules.home-manager

    ../../modules/primary-user.nix
    ../../modules/nix
    ../../modules/nix/nix-ld.nix
    ../../modules/ssh
    ../../modules/ssh/authorized-keys.nix
    ../../modules/tailscale
    ../../modules/tailnet-registry
    ../../modules/secrets
    ../../modules/fonts
    ../../modules/nix/auto-upgrade.nix
    ../../modules/o11y
    ../../modules/t3-code/server.nix
    ../../modules/syncthing
    ../../modules/audio
    ../../modules/bluetooth
    ../../modules/flatpak
    ../../modules/homebrew
    ../../modules/homebrew/environment.nix
    ../../modules/homebrew/best-effort.nix
    ../../modules/macos-defaults
    ../../modules/sleepless
    ../../modules/kanata
    ../../modules/cmux
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
    ../../modules/syncthing/automerge
    ../../modules/wikiman
    ../../modules/yt-dlp
    ../../modules/gallery-dl
    ../../modules/rust
    ../../modules/go
    ../../modules/fairy-name
    ../../modules/pi
    ../../modules/pi-memory
    ../../modules/e-ink-glass
    ../../modules/ghostty
    ../../modules/open-display
    ../../modules/vscodium
    ../../modules/1password
    ../../modules/orbstack
    ../../modules/obs
    ../../modules/helium/remotes.nix
    ../../modules/gaming
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
      { lib
      , pkgs
      , config
      , ...
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
          libimobiledevice
          ifuse
          vscode
          obsidian
          rclone
          qpdf
          inputs.lnr.packages.aarch64-darwin.default
          axiom-cli
          hcloud
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

        # declarative syncthing settings; the feature module owns the daemon.
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
              "mbp-m5"
              "htz-relay"
              "lgo-z2e"
              "mmn-m4"
              "iph16"
              "ipd"
              "kindle"
            ];

            folders = {
              commonplace = syncthing.folderFor "commonplace" config.home.homeDirectory true [
                "mbp-m5"
                "htz-relay"
                "lgo-z2e"
                "mmn-m4"
                "iph16"
                "ipd"
              ]
                { label = "commonplace"; };
              pi-sessions = syncthing.folderFor "pi-sessions" config.home.homeDirectory true [
                "mbp-m5"
                "lgo-z2e"
              ] { };
              helium-remotes = syncthing.folderFor "helium-remotes" config.home.homeDirectory true [
                "htz-relay"
                "lgo-z2e"
              ]
                { };
              kindle = syncthing.folderFor "kindle" config.home.homeDirectory true [
                "kindle"
                "mmn-m4"
              ]
                { };
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
  my.openDisplay = {
    launchAtLogin = false;
    mode = "mirror";
    wifiServiceName = "iPad";
  };
  # Bootstrap aarch64-linux guest builds without making the 16 GB storage host
  # carry a second build VM alongside the household appliance.
  nix = {
    linux-builder.enable = true;
    settings.trusted-users = [ "@admin" ];
  };
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
