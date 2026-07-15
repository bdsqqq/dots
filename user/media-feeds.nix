{ config, lib, pkgs, ... }:
let
  cfg = config.my.mediaFeeds;
  configSource = "/Users/bdsqqq/commonplace/01_files/nix/user/media-feeds/config.yml";
  configPath = "/Users/bdsqqq/.config/flexget/config.yml";
  transmissionConfigDir = "/Users/bdsqqq/.config/transmission-daemon";
  logPath = "/Users/bdsqqq/Library/Logs/media-feeds.log";
in
{
  options.my.mediaFeeds = {
    enable = lib.mkEnableOption "RSS-driven Transmission downloads";

    root = lib.mkOption {
      type = lib.types.str;
      default = "/Users/bdsqqq/commonplace/03_media/feeds";
      description = "Root directory containing one directory per feed.";
    };

    feeds = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Feed names that receive complete and Kindle directories.";
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
    assertions = map
      (name: {
        assertion =
          name != "."
          && name != ".."
          && builtins.match "^[A-Za-z0-9._-]+$" name != null;
        message = "my.mediaFeeds feed names may only contain letters, numbers, dots, underscores, and hyphens";
      })
      cfg.feeds;

    home-manager.users.bdsqqq = { lib, ... }: {
      home.packages = [ pkgs.flexget pkgs.transmission_4 ];

      home.activation.mediaFeedDirectories =
        lib.hm.dag.entryAfter [ "writeBoundary" ] ''
          mkdir -p "${cfg.root}/.incomplete" \
            "/Users/bdsqqq/.config/flexget" \
            "${transmissionConfigDir}"
          ln -sfn "${configSource}" "${configPath}"
          ${lib.concatMapStringsSep "\n" (name: ''
            mkdir -p "${cfg.root}/${name}/complete" \
              "${cfg.root}/${name}/kindle"
          '') cfg.feeds}
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

      launchd.agents.media-feed-poller = lib.mkIf cfg.polling.enable {
        enable = true;
        config = {
          ProgramArguments = [
            "${pkgs.flexget}/bin/flexget"
            "-c"
            configPath
            "execute"
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
