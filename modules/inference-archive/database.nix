{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.inferenceArchive.database;
  user = config.my.primaryUser;
  home = config.home-manager.users.${user}.home.homeDirectory;
  runtimePath = lib.types.addCheck lib.types.str (
    path: lib.hasPrefix "/" path && !lib.hasPrefix "/nix/store/" path && path != "/"
  );
  seed = pkgs.writeText "inference-clickhouse-server.xml" ''
    <clickhouse>
      <listen_host>127.0.0.1</listen_host><http_port>${toString cfg.port}</http_port>
      <path>${cfg.dataDirectory}/</path><tmp_path>${cfg.dataDirectory}/tmp/</tmp_path>
      <user_files_path>${cfg.dataDirectory}/user_files/</user_files_path>
      <users_config>${cfg.configDirectory}/users.xml</users_config>
      <logger><level>warning</level><console>true</console></logger>
      <max_server_memory_usage>2147483648</max_server_memory_usage>
      <background_pool_size>4</background_pool_size><background_schedule_pool_size>4</background_schedule_pool_size>
      <merge_tree><number_of_free_entries_in_pool_to_execute_mutation>2</number_of_free_entries_in_pool_to_execute_mutation><number_of_free_entries_in_pool_to_lower_max_size_of_merge>2</number_of_free_entries_in_pool_to_lower_max_size_of_merge><number_of_free_entries_in_pool_to_execute_optimize_entire_partition>2</number_of_free_entries_in_pool_to_execute_optimize_entire_partition></merge_tree>
    </clickhouse>
  '';
  server = pkgs.writeShellApplication {
    name = "inference-archive-database";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.openssl
    ];
    text = ''
      umask 077
      mkdir -p ${
        lib.escapeShellArgs [
          cfg.configDirectory
          cfg.dataDirectory
        ]
      }
      password=${lib.escapeShellArg cfg.passwordFile}
      if [ ! -e "$password" ]; then
        # noclobber preserves a concurrent/native provisioning attempt.
        (set -C; openssl rand -hex 32 > "$password")
      fi
      test -f "$password" && test ! -L "$password"
      test "$(stat -c %a "$password")" = 600
      if [ ! -e ${lib.escapeShellArg "${cfg.configDirectory}/users.xml"} ]; then
        hash="$(tr -d '\r\n' < "$password" | sha256sum | cut -d' ' -f1)"
        (set -C; printf '<clickhouse><users><archive><password_sha256_hex>%s</password_sha256_hex><networks><ip>127.0.0.1</ip><ip>::1</ip></networks><profile>archive</profile><quota>default</quota></archive></users><profiles><default/><archive><max_memory_usage>1073741824</max_memory_usage><max_threads>2</max_threads><log_queries>0</log_queries></archive></profiles><quotas><default/></quotas></clickhouse>\n' "$hash" > ${lib.escapeShellArg "${cfg.configDirectory}/users.xml"})
      fi
      if [ ! -e ${lib.escapeShellArg "${cfg.configDirectory}/server.xml"} ]; then
        cp --no-clobber ${seed} ${lib.escapeShellArg "${cfg.configDirectory}/server.xml"}
        chmod 600 ${lib.escapeShellArg "${cfg.configDirectory}/server.xml"}
      fi
      exec ${cfg.package}/bin/clickhouse server --config-file=${lib.escapeShellArg "${cfg.configDirectory}/server.xml"}
    '';
  };
  indexer = pkgs.writeShellApplication {
    name = "inference-archive-indexer";
    text = ''
      # live indexer: ${builtins.hashFile "sha256" ./ingest.ts}
      # verifier: ${builtins.hashFile "sha256" ./verify.ts}
      umask 077
      exec ${pkgs.nodejs_24}/bin/node ${lib.escapeShellArg "${cfg.indexer.sourceDirectory}/ingest.ts"} \
        --root ${lib.escapeShellArg cfg.indexer.archiveRoot} \
        --endpoint ${lib.escapeShellArg cfg.indexer.endpoint} \
        --username archive --password-file ${lib.escapeShellArg cfg.indexer.passwordFile} \
        --lock-port ${toString cfg.indexer.lockPort} "$@"
    '';
  };
in
{
  options.my.inferenceArchive.database = {
    enable = lib.mkEnableOption "private inference archive ClickHouse (Linux server)";
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.clickhouse;
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 18923;
    };
    configDirectory = lib.mkOption {
      type = runtimePath;
      default = "${home}/.config/inference-archive-database";
    };
    dataDirectory = lib.mkOption {
      type = runtimePath;
      default = "${home}/.local/share/inference-archive-database";
    };
    passwordFile = lib.mkOption {
      type = runtimePath;
      default = "${cfg.configDirectory}/password";
    };
    serverCommand = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = "${server}/bin/inference-archive-database";
    };
    indexer = {
      enable = lib.mkEnableOption "journal-to-ClickHouse indexer, independent of database placement";
      sourceDirectory = lib.mkOption {
        type = runtimePath;
        default = "${home}/commonplace/01_files/nix/modules/inference-archive";
      };
      archiveRoot = lib.mkOption {
        type = runtimePath;
        default = "${home}/.local/share/inference-archive";
      };
      endpoint = lib.mkOption {
        type = lib.types.str;
        default = "http://127.0.0.1:${toString cfg.port}";
      };
      passwordFile = lib.mkOption {
        type = runtimePath;
        default = cfg.passwordFile;
      };
      lockPort = lib.mkOption {
        type = lib.types.port;
        default = 18924;
      };
      command = lib.mkOption {
        type = lib.types.str;
        readOnly = true;
        default = "${indexer}/bin/inference-archive-indexer";
      };
    };
  };
  config = lib.mkIf (cfg.enable || cfg.indexer.enable) {
    assertions = [
      {
        assertion = !cfg.enable || pkgs.stdenv.hostPlatform.isLinux;
        message = "archive database server requires Linux; Darwin can run the indexer";
      }
      {
        assertion =
          !cfg.indexer.enable
          || lib.hasPrefix "https://" cfg.indexer.endpoint
          || lib.hasPrefix "http://127.0.0.1:" cfg.indexer.endpoint;
        message = "archive indexer requires authenticated HTTPS or loopback HTTP";
      }
    ];
    home-manager.users.${user} = { ... }: {
      home.packages = lib.optional cfg.enable server ++ lib.optional cfg.indexer.enable indexer;
      # Source and manifests remain live. No activation overwrites editable XML.
      systemd.user.services = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux (
        lib.optionalAttrs cfg.enable {
          inference-archive-database = {
            Unit.Description = "private inference archive derived query index";
            Service = {
              ExecStart = "${server}/bin/inference-archive-database";
              Restart = "on-failure";
              RestartSec = 10;
              UMask = "0077";
            };
            Install.WantedBy = [ "default.target" ];
          };
        }
        // lib.optionalAttrs cfg.indexer.enable {
          inference-archive-indexer = {
            Unit.Description = "durable inference journal indexer";
            Service = {
              ExecStart = "${indexer}/bin/inference-archive-indexer";
              Restart = "on-failure";
              RestartSec = 10;
              UMask = "0077";
            };
            Install.WantedBy = [ "default.target" ];
          };
        }
      );
      launchd.agents = lib.optionalAttrs (pkgs.stdenv.hostPlatform.isDarwin && cfg.indexer.enable) {
        inference-archive-indexer = {
          enable = true;
          domain = "user";
          config = {
            ProgramArguments = [ "${indexer}/bin/inference-archive-indexer" ];
            RunAtLoad = true;
            KeepAlive = true;
            ThrottleInterval = 10;
            ProcessType = "Background";
            Umask = 63;
            StandardErrorPath = "${home}/Library/Logs/inference-archive-indexer.log";
          };
        };
      };
    };
  };
}
