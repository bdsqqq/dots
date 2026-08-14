{ config, hostSystem, lib, pkgs, ... }:

let
  cfg = config.my.tailnetRegistry;
  isDarwin = lib.hasSuffix "-darwin" hostSystem;
  isLinux = lib.hasSuffix "-linux" hostSystem;
  serviceType = lib.types.submodule ({ config, name, ... }: {
    options = {
      title = lib.mkOption {
        type = lib.types.str;
        default = name;
        description = "Human-readable service name.";
      };

      description = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Short explanation shown in the service directory.";
      };

      target = lib.mkOption {
        type = lib.types.str;
        example = "http://127.0.0.1:8080";
        description = "Loopback HTTP backend published through Tailscale Serve.";
      };

      scheme = lib.mkOption {
        type = lib.types.enum [ "http" "https" ];
        default = "https";
        description = "Protocol exposed by Tailscale Serve.";
      };

      port = lib.mkOption {
        type = lib.types.port;
        description = "Port exposed on the host's Tailscale address.";
      };

      path = lib.mkOption {
        type = lib.types.str;
        default = "/";
        description = "Browser path used to open the service.";
      };

      healthPath = lib.mkOption {
        type = lib.types.str;
        default = "/";
        description = "Path probed locally and reported to the fleet directory.";
      };

      access = {
        tailnet = lib.mkOption {
          type = lib.types.enum [ "owner" "family" "machines" ];
          default = if config.audience == null then "owner" else config.audience;
          description =
            "Intended tailnet access class; enforcement remains in the tailnet policy.";
        };

        cloudflare = lib.mkOption {
          type = lib.types.enum [ "disabled" "owner" "family" "public" ];
          default = "disabled";
          description =
            "Intended Cloudflare exposure class; enforcement and group membership remain private Cloudflare state.";
        };
      };

      audience = lib.mkOption {
        type = lib.types.nullOr (lib.types.enum [ "owner" "family" "machines" ]);
        default = null;
        description = "Deprecated alias for access.tailnet.";
      };

      adoptExisting = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description =
          "Explicitly transfer an exactly matching existing Serve route to the registry.";
      };

      tailscaleService = {
        enable = lib.mkEnableOption "a portable native Tailscale Service endpoint";

        name = lib.mkOption {
          type = lib.types.strMatching "[a-z0-9][a-z0-9-]{0,63}";
          default = name;
          description = "Stable Tailscale Service name, without the svc: prefix.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          default = 443;
          description = "HTTPS port exposed by the native Tailscale Service.";
        };

        adoptExisting = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description =
            "Explicitly transfer an exactly matching existing native Service endpoint to the registry.";
        };
      };
    };
  });
  active =
    cfg.services != { }
    || cfg.directory.enable
    || cfg.directory.tailscaleService.enable;
  allPorts =
    (map (service: service.port) (lib.attrValues cfg.services))
    ++ [ cfg.manifest.port ]
    ++ lib.optional cfg.directory.enable cfg.directory.port;
  loopbackTarget = target:
    builtins.match
      "^https?://(127[.]0[.]0[.]1|localhost)(:[0-9]+)?(/.*)?$"
      target != null;
  normalizedServices = lib.mapAttrs
    (_: service: {
      inherit (service)
        adoptExisting
        description
        healthPath
        path
        port
        scheme
        target
        title
        ;
      inherit (service) access;
      tailscaleService = {
        inherit (service.tailscaleService)
          adoptExisting
          enable
          name
          port
          ;
      };
    })
    cfg.services;
  nativeServiceNames =
    map
      (service: service.tailscaleService.name)
      (lib.filter
        (service: service.tailscaleService.enable)
        (lib.attrValues cfg.services))
    ++ lib.optional cfg.directory.tailscaleService.enable
      cfg.directory.tailscaleService.name;
  hostName =
    if isDarwin
    then config.networking.localHostName
    else config.networking.hostName;
  registryConfig = pkgs.writeText "tailnet-registry.json" (builtins.toJSON {
    schemaVersion = 1;
    host = {
      name = hostName;
    };
    manifest = {
      inherit (cfg.manifest) port backendPort;
    };
    directory = {
      inherit (cfg.directory) enable port backendPort;
      tailscaleService = {
        inherit (cfg.directory.tailscaleService)
          adoptExisting
          enable
          name
          port
          ;
      };
    };
    services = normalizedServices;
  });
  registryPackage = pkgs.writeShellApplication {
    name = "tailnet-registry";
    runtimeInputs = [
      pkgs.bun
      pkgs.tailscale
    ];
    text = ''
      exec bun ${./tailnet-registry.ts} "$@"
    '';
  };
  primaryUser = config.my.primaryUser;
  primaryHome = config.users.users.${primaryUser}.home;
  darwinStateDir = "${primaryHome}/Library/Application Support/tailnet-registry";
  registryArgs = stateDir: [
    "${registryPackage}/bin/tailnet-registry"
    "--config"
    registryConfig
    "--state-dir"
    stateDir
  ];
in
{
  options.my.tailnetRegistry = {
    services = lib.mkOption {
      type = lib.types.attrsOf serviceType;
      default = { };
      description =
        "Host-local services announced to the tailnet service directory.";
    };

    manifest = {
      port = lib.mkOption {
        type = lib.types.port;
        default = 5252;
        description = "Tailnet HTTP port for the host's public service manifest.";
      };

      backendPort = lib.mkOption {
        type = lib.types.port;
        default = 15252;
        description = "Loopback port used by the manifest server.";
      };
    };

    directory = {
      enable = lib.mkEnableOption "the fleet-wide tailnet service directory";

      port = lib.mkOption {
        type = lib.types.port;
        default = 5253;
        description = "Tailnet HTTPS port for the service directory.";
      };

      backendPort = lib.mkOption {
        type = lib.types.port;
        default = 15253;
        description = "Loopback port used by the directory server.";
      };

      tailscaleService = {
        enable = lib.mkEnableOption "a portable native Tailscale Service for the directory";

        name = lib.mkOption {
          type = lib.types.strMatching "[a-z0-9][a-z0-9-]{0,63}";
          default = "apps";
          description = "Stable Tailscale Service name, without the svc: prefix.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          default = 443;
          description = "HTTPS port exposed by the directory's native Tailscale Service.";
        };

        adoptExisting = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description =
            "Explicitly transfer an exactly matching existing directory Service endpoint to the registry.";
        };
      };
    };
  };

  config = lib.mkIf active (lib.mkMerge [
    {
      assertions = [
        {
          assertion = builtins.length allPorts
            == builtins.length (lib.unique allPorts);
          message =
            "my.tailnetRegistry services, manifest, and directory must use unique tailnet ports";
        }
        {
          assertion =
            !cfg.directory.enable
            || cfg.manifest.backendPort != cfg.directory.backendPort;
          message =
            "my.tailnetRegistry manifest and directory backend ports must be unique";
        }
        {
          assertion =
            !cfg.directory.tailscaleService.enable || cfg.directory.enable;
          message =
            "my.tailnetRegistry.directory.tailscaleService requires the directory";
        }
        {
          assertion = lib.all
            (service: service.audience == null || service.access.tailnet == service.audience)
            (lib.attrValues cfg.services);
          message =
            "my.tailnetRegistry service audience conflicts with access.tailnet";
        }
        {
          assertion = builtins.length nativeServiceNames
            == builtins.length (lib.unique nativeServiceNames);
          message =
            "my.tailnetRegistry native Tailscale Service names must be unique per host";
        }
        {
          assertion = lib.all loopbackTarget
            (map (service: service.target) (lib.attrValues cfg.services));
          message =
            "my.tailnetRegistry service targets must use an HTTP(S) loopback address";
        }
        {
          assertion = lib.all
            (service:
              lib.hasPrefix "/" service.path
              && lib.hasPrefix "/" service.healthPath)
            (lib.attrValues cfg.services);
          message =
            "my.tailnetRegistry service paths and health paths must begin with /";
        }
      ];

      environment.systemPackages = [ registryPackage ];
    }

    (lib.optionalAttrs isLinux {
      systemd.services.tailnet-registry = {
        description = "Tailnet service registry and directory";
        wantedBy = [ "multi-user.target" ];
        wants = [
          "network-online.target"
          "tailscaled.service"
        ];
        after = [
          "network-online.target"
          "tailscaled.service"
        ];
        serviceConfig = {
          Type = "simple";
          ExecStart = lib.escapeShellArgs (registryArgs "/var/lib/tailnet-registry");
          Restart = "always";
          RestartSec = "5s";
          StateDirectory = "tailnet-registry";
        };
      };
    })

    (lib.optionalAttrs isDarwin {
      launchd.user.agents.tailnet-registry = {
        path = [
          pkgs.coreutils
          pkgs.tailscale
        ];
        command = lib.escapeShellArgs (registryArgs darwinStateDir);
        serviceConfig = {
          Label = "dev.tailnet.registry";
          RunAtLoad = true;
          KeepAlive = true;
          ThrottleInterval = 10;
          ProcessType = "Background";
          StandardOutPath =
            "${primaryHome}/Library/Logs/tailnet-registry.log";
          StandardErrorPath =
            "${primaryHome}/Library/Logs/tailnet-registry.log";
        };
      };
    })
  ]);
}
