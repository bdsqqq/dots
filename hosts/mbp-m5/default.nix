{ lib
, inputs
, pkgs
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
    ../../modules/fonts
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
    ../../modules/syncthing
    ../../modules/syncthing/automerge
    ../../modules/wikiman
    ../../modules/yt-dlp
    ../../modules/gallery-dl
    ../../modules/rust
    ../../modules/go
    ../../modules/fairy-name
    ../../modules/pi
    ../../modules/e-ink-glass
    ../../modules/ghostty
    ../../modules/open-display
    ../../modules/vscodium
    ../../modules/obsidian
    ../../modules/1password
    ../../modules/orbstack
    ../../modules/obs
    ../../modules/helium/remotes.nix
  ];

  networking = {
    hostName = "mbp-m5.local";
    localHostName = "mbp-m5";
    computerName = "mbp-m5";
  };

  users.users.bdsqqq.home = "/Users/bdsqqq";
  system.primaryUser = "bdsqqq";
  my.primaryUser = "bdsqqq";
  my.openDisplay = {
    launchAtLogin = false;
    mode = "mirror";
    wifiServiceName = "iPad";
  };
  my.heliumRemotes = {
    enable = true;
    tabsExtension.enable = true;
  };

  nix = {
    linux-builder.enable = true;
    settings.trusted-users = [ "@admin" ];
  };

  homebrew.casks = [
    "cleanshot"
    "tailscale-app"
    "tableplus"
    "figma"
    "obs"
    "transmission"
    "linear"
    "vscodium"
  ];

  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    extraSpecialArgs = {
      inherit inputs systems pkgsFor;
      isDarwin = true;
      hostSystem = "aarch64-darwin";
      headMode = "graphical";
    };
    users.bdsqqq = {
      home = {
        username = "bdsqqq";
        homeDirectory = "/Users/bdsqqq";
        stateVersion = "25.05";
        packages = with pkgs; [
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
      };
      programs.home-manager.enable = true;

      services.syncthing = {
        enable = true;
        overrideFolders = true;
        overrideDevices = true;
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
            "mbp-m2"
            "htz-relay"
            "lgo-z2e"
            "mmn-m4"
            "iph16"
            "ipd"
          ];
          folders = {
            commonplace = syncthing.folderFor "commonplace" "/Users/bdsqqq" true [
              "mbp-m2"
              "htz-relay"
              "lgo-z2e"
              "mmn-m4"
              "iph16"
              "ipd"
            ] { label = "commonplace"; };
            pi-sessions = syncthing.folderFor "pi-sessions" "/Users/bdsqqq" true [
              "mbp-m2"
              "lgo-z2e"
            ] { };
          };
        };
      };

      home.file.".local/state/syncthing/.keep".text = "";
      launchd.agents = {
        syncthing.config = {
          RunAtLoad = true;
          StandardOutPath = lib.mkForce "/Users/bdsqqq/.local/state/syncthing/stdout.log";
          StandardErrorPath = lib.mkForce "/Users/bdsqqq/.local/state/syncthing/stderr.log";
        };
        syncthing-init.config = {
          RunAtLoad = true;
          StandardOutPath = lib.mkForce "/Users/bdsqqq/.local/state/syncthing/init-stdout.log";
          StandardErrorPath = lib.mkForce "/Users/bdsqqq/.local/state/syncthing/init-stderr.log";
        };
        syncthing-automerge.config = {
          StandardOutPath = lib.mkForce "/Users/bdsqqq/.local/state/syncthing/automerge.log";
          StandardErrorPath = lib.mkForce "/Users/bdsqqq/.local/state/syncthing/automerge.log";
        };
      };
    };
  };

  system.stateVersion = 6;
  nixpkgs = {
    hostPlatform = "aarch64-darwin";
    config.allowUnfree = true;
  };
}
