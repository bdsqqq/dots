{ config, lib, pkgs, ... }:
let
  cfg = config.my.mediaFeeds;
  configSource = "/Users/bdsqqq/commonplace/01_files/nix/user/media-feeds/config.yml";
  pollerSource = "/Users/bdsqqq/commonplace/01_files/nix/user/media-feeds/poll.sh";
  configPath = "/Users/bdsqqq/.config/flexget/config.yml";
  variablesPath = "/Users/bdsqqq/.config/flexget/media-feed-variables.yml";
  onePieceKindleDirectory = "/Users/bdsqqq/kindle/one piece";
  moduloKindleDirectory = "/Users/bdsqqq/kindle/jujutsu kaisen modulo";
  moduloImportMarker = "/Users/bdsqqq/.config/flexget/nyaa-2120944.imported";
  transmissionConfigDir = "/Users/bdsqqq/.config/transmission-daemon";
  logPath = "/Users/bdsqqq/Library/Logs/media-feeds.log";
  importModulo = pkgs.writeShellScript "import-jujutsu-kaisen-modulo" ''
    set -euo pipefail

    [[ -e ${lib.escapeShellArg moduloImportMarker} ]] && exit 0
    mkdir -p ${lib.escapeShellArg moduloKindleDirectory}
    ${pkgs.transmission_4}/bin/transmission-remote 127.0.0.1:9091 \
      --add https://nyaa.si/download/2120944.torrent \
      --download-dir ${lib.escapeShellArg moduloKindleDirectory}
    touch ${lib.escapeShellArg moduloImportMarker}
  '';
in
{
  options.my.mediaFeeds = {
    enable = lib.mkEnableOption "RSS-driven Transmission downloads";

    root = lib.mkOption {
      type = lib.types.str;
      default = "/Users/bdsqqq/commonplace/03_media/feeds";
      description = "Transmission fallback and incomplete-download root.";
    };

    polling = {
      enable = lib.mkEnableOption "periodic FlexGet execution";
      interval = lib.mkOption {
        type = lib.types.ints.positive;
        default = 900;
        description = "FlexGet polling interval in seconds.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    home-manager.users.bdsqqq = { lib, ... }: {
      home.packages = [ pkgs.flexget pkgs.transmission_4 ];

      home.activation.mediaFeedState =
        lib.hm.dag.entryAfter [ "writeBoundary" ] ''
          mkdir -p "${cfg.root}/.incomplete" \
            "/Users/bdsqqq/.config/flexget" \
            "${transmissionConfigDir}"
          ln -sfn "${configSource}" "${configPath}"
          if [[ ! -e "${variablesPath}" ]]; then
            printf 'one_piece_begin: 1171\n' > "${variablesPath}"
          fi
        '';

      launchd.agents.transmission-daemon = lib.mkIf cfg.polling.enable {
        enable = true;
        config = {
          ProgramArguments = [
            "${pkgs.transmission_4}/bin/transmission-daemon"
            "--foreground"
            "--config-dir"
            transmissionConfigDir
            "--download-dir"
            cfg.root
            "--incomplete-dir"
            "${cfg.root}/.incomplete"
            "--no-portmap"
            "--rpc-bind-address"
            "127.0.0.1"
          ];
          RunAtLoad = true;
          KeepAlive = true;
          ProcessType = "Background";
          StandardOutPath = logPath;
          StandardErrorPath = logPath;
        };
      };

      launchd.agents.media-feed-import-modulo = lib.mkIf cfg.polling.enable {
        enable = true;
        config = {
          ProgramArguments = [ "${importModulo}" ];
          RunAtLoad = true;
          KeepAlive.SuccessfulExit = false;
          ThrottleInterval = 5;
          ProcessType = "Background";
          StandardOutPath = logPath;
          StandardErrorPath = logPath;
        };
      };

      launchd.agents.media-feed-poller = lib.mkIf cfg.polling.enable {
        enable = true;
        config = {
          # RSS has no push API, so KOReader reconciliation shares its polling interval.
          ProgramArguments = [
            "${pkgs.bash}/bin/bash"
            pollerSource
            "${pkgs.flexget}/bin/flexget"
            configPath
            variablesPath
            onePieceKindleDirectory
          ];
          RunAtLoad = true;
          StartInterval = cfg.polling.interval;
          ProcessType = "Background";
          StandardOutPath = logPath;
          StandardErrorPath = logPath;
        };
      };
    };
  };
}
