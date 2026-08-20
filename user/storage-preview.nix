{
  config,
  lib,
  pkgs,
  ...
}:

let
  home = "/Users/bdsqqq";
  galleryRoot = "/Volumes/ssd-01/igor/photos-library-2";
  copypartyCache = "${home}/Library/Caches/copyparty-ssd";
  filesBrowserCache = "${home}/Library/Caches/copyparty-files";
  syncthingConfig = "${home}/Library/Application Support/Syncthing/config.xml";
  backrestConfigDir = "${home}/.config/backrest";
  backrestDataDir = "${home}/.local/share/backrest";
  resticSecret = "${home}/commonplace/01_files/nix/restic/secrets.yaml";
  sopsAgeKey = "${home}/.config/sops/age/keys.txt";
  storageBoxKey = "${home}/.ssh/id_ed25519";

  backrestConfig = pkgs.writeText "backrest-storage-preview.json" (
    builtins.toJSON {
      modno = 1;
      version = 6;
      instance = config.networking.localHostName;
      repos = [
        {
          id = "ssd-01-hetzner";
          uri = "sftp:u646875@u646875.your-storagebox.de:/home/restic/ssd-01";
          guid = "db9719f847da679dbbbdca1d9cbe716f1c462fa23966d5abdcf1cf0a04ad0993";
          password = "";
          env = [
            "RESTIC_PASSWORD_COMMAND=/usr/bin/env SOPS_AGE_KEY_FILE=${sopsAgeKey} /etc/profiles/per-user/bdsqqq/bin/sops --decrypt --extract '[\"restic_ssd_01_password\"]' ${resticSecret}"
          ];
          flags = [
            "-o 'sftp.args=-p 23 -oBatchMode=yes -oIdentitiesOnly=yes -i ${storageBoxKey}'"
          ];
          prunePolicy.schedule.disabled = true;
          checkPolicy = {
            schedule.maxFrequencyDays = 7;
            structureOnly = true;
          };
          autoUnlock = true;
          autoInitialize = false;
          hooks = [ ];
        }
      ];
      plans = [ ];
      auth = {
        disabled = true;
        users = [ ];
      };
    }
  );

  photoGalleryServer = import ../modules/photo-gallery { inherit pkgs; };
  filesBrowserServer = import ../modules/files-browser { inherit pkgs; };

  backrestServer = pkgs.writeShellApplication {
    name = "backup-health-server";
    runtimeInputs = [
      pkgs.backrest
      pkgs.openssh
      pkgs.restic
      pkgs.sops
    ];
    text = ''
      cleanup() {
        if [[ -n "''${server_pid:-}" ]] && kill -0 "$server_pid" 2>/dev/null; then
          kill "$server_pid"
          wait "$server_pid" 2>/dev/null || true
        fi
      }
      trap cleanup EXIT
      trap 'exit 143' TERM
      trap 'exit 130' INT

      backrest \
        -bind-address 127.0.0.1:9898 \
        -config-file ${lib.escapeShellArg "${backrestConfigDir}/config.json"} \
        -data-dir ${lib.escapeShellArg backrestDataDir} \
        -restic-cmd ${pkgs.restic}/bin/restic &
      server_pid=$!

      wait "$server_pid"
    '';
  };
in
{
  my.tailnetRegistry.services = {
    files = {
      title = "files";
      description = "read-only commonplace file browser";
      target = "http://127.0.0.1:3925";
      scheme = "https";
      port = 3925;
      healthPath = "/";
      access.tailnet = "owner";
      tailscaleService.enable = true;
    };

    gallery = {
      title = "family photos";
      description = "read-only household photo gallery";
      target = "http://127.0.0.1:3923";
      scheme = "https";
      port = 3923;
      path = "/gallery/";
      healthPath = "/gallery/";
      access = {
        tailnet = "family";
        cloudflare = "family";
      };
      adoptExisting = true;
      tailscaleService = {
        enable = true;
        name = "photos";
      };
    };

    backup-health = {
      title = "backrest";
      description = "backup console reachable; backup outcome is not yet reported";
      target = "http://127.0.0.1:9898";
      scheme = "https";
      port = 9898;
      healthPath = "/";
      access.tailnet = "owner";
      adoptExisting = true;
    };
  };

  home-manager.users.bdsqqq = { config, lib, ... }: {
    home.packages = [
      backrestServer
      filesBrowserServer
      photoGalleryServer
    ];

    home.activation.storagePreviewState = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      mkdir -p \
        ${lib.escapeShellArg backrestConfigDir} \
        ${lib.escapeShellArg backrestDataDir} \
        ${lib.escapeShellArg copypartyCache} \
        ${lib.escapeShellArg filesBrowserCache}
      if [[ ! -e ${lib.escapeShellArg "${backrestConfigDir}/config.json"} ]]; then
        ${pkgs.coreutils}/bin/install \
          -m 0600 \
          ${backrestConfig} \
          ${lib.escapeShellArg "${backrestConfigDir}/config.json"}
      fi
    '';

    launchd.agents.files-browser = {
      enable = true;
      config = {
        ProgramArguments = [
          "${filesBrowserServer}/bin/files-browser-server"
          "--source"
          "${home}/commonplace"
          "--state"
          filesBrowserCache
          "--syncthing-config"
          syncthingConfig
          "--syncthing-url"
          "http://127.0.0.1:8384"
          "--port"
          "3925"
        ];
        RunAtLoad = true;
        KeepAlive = true;
        ThrottleInterval = 10;
        ProcessType = "Background";
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/files-browser.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/files-browser.log";
      };
    };

    launchd.agents.ssd-gallery = {
      enable = true;
      config = {
        ProgramArguments = [
          "${photoGalleryServer}/bin/photo-gallery-server"
          "--source"
          galleryRoot
          "--state"
          copypartyCache
          "--port"
          "3923"
        ];
        RunAtLoad = true;
        KeepAlive = true;
        ThrottleInterval = 10;
        ProcessType = "Background";
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/ssd-gallery.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/ssd-gallery.log";
      };
    };

    launchd.agents.backup-health = {
      enable = true;
      config = {
        ProgramArguments = [ "${backrestServer}/bin/backup-health-server" ];
        RunAtLoad = true;
        KeepAlive = true;
        ThrottleInterval = 10;
        ProcessType = "Background";
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/backup-health.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/backup-health.log";
      };
    };
  };
}
