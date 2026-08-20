{ config, lib, pkgs, ... }:

let
  cfg = config.my.cloudflareIngress;
  containerAddress = "10.233.2.2";
  hostAddress = "10.233.2.1";
  tailscalePackage = pkgs.unstable.tailscale;
  tunnelConfig = name: app:
    pkgs.writeText "cloudflare-ingress-${name}.json" (builtins.toJSON {
      tunnel = app.tunnel.id;
      credentials-file = "/run/credentials/cloudflare-ingress-${name}.service/tunnel.json";
      ingress = [
        {
          inherit (app.route) hostname service;
          originRequest = {
            originServerName = app.route.originServerName;
            httpHostHeader = app.route.originServerName;
            access = {
              required = true;
              teamName = cfg.access.teamName;
              audTag = [ app.access.audienceTag ];
            };
          };
        }
        { service = "http_status:404"; }
      ];
    });
  originProbe = app: lib.escapeShellArgs [
    "${pkgs.curl}/bin/curl"
    "--fail"
    "--silent"
    "--show-error"
    "--connect-timeout"
    "5"
    "--max-time"
    "10"
    "--output"
    "/dev/null"
    app.route.service
  ];
  cloudflaredCommand = name: app: lib.escapeShellArgs [
    "${pkgs.cloudflared}/bin/cloudflared"
    "tunnel"
    "--config=${tunnelConfig name app}"
    "--no-autoupdate"
    "run"
  ];
  cloudflaredWithOriginWatchdog = name: app:
    pkgs.writeShellScript "cloudflared-${name}-with-origin-watchdog" ''
      probe_origin() {
        ${originProbe app}
      }

      if ! probe_origin; then
        echo "origin probe failed; connector will remain withdrawn" >&2
        exit 1
      fi

      connector_pid=""
      watchdog_pid=""
      cleanup() {
        if [[ -n "$watchdog_pid" ]]; then
          kill "$watchdog_pid" 2>/dev/null || true
        fi
        if [[ -n "$connector_pid" ]]; then
          kill "$connector_pid" 2>/dev/null || true
        fi
        wait 2>/dev/null || true
      }
      trap cleanup EXIT INT TERM

      ${cloudflaredCommand name app} &
      connector_pid=$!

      (
        while ${pkgs.coreutils}/bin/sleep 15; do
          if ! probe_origin; then
            echo "origin probe failed; withdrawing connector" >&2
            kill "$connector_pid" 2>/dev/null || true
            exit 1
          fi
        done
      ) &
      watchdog_pid=$!

      wait -n "$connector_pid" "$watchdog_pid"
      exit $?
    '';
  appSecrets = lib.mapAttrs'
    (_: app: lib.nameValuePair app.tunnel.credentialsSecret {
      owner = "root";
      mode = "0400";
    })
    cfg.apps;
  appSecretMounts = lib.mapAttrs'
    (name: app: lib.nameValuePair "/run/secrets/cloudflare-tunnel-${name}.json" {
      hostPath = config.sops.secrets.${app.tunnel.credentialsSecret}.path;
      isReadOnly = true;
    })
    cfg.apps;
  appServices = lib.mapAttrs'
    (name: app: lib.nameValuePair "cloudflare-ingress-${name}" {
      description = "Cloudflare ingress for ${name} through a least-privilege tailnet identity";
      wantedBy = [ "multi-user.target" ];
      requires = [ "tailscaled-autoconnect.service" ];
      wants = [ "network-online.target" ];
      after = [
        "network-online.target"
        "tailscaled-autoconnect.service"
      ];
      serviceConfig = {
        DynamicUser = true;
        LoadCredential = "tunnel.json:/run/secrets/cloudflare-tunnel-${name}.json";
        ExecStart = cloudflaredWithOriginWatchdog name app;
        Restart = "always";
        RestartSec = "5s";
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectHome = true;
        ProtectSystem = "strict";
      };
    })
    cfg.apps;
in
{
  options.my.cloudflareIngress = {
    enable = lib.mkEnableOption "an isolated Cloudflare-to-tailnet connector";

    connectorName = lib.mkOption {
      type = lib.types.strMatching "[a-z0-9][a-z0-9-]{0,62}";
      description = "Unique Tailscale hostname for this connector.";
    };

    externalInterface = lib.mkOption {
      type = lib.types.str;
      description = "Host interface used to NAT the connector container.";
    };

    tailscaleAuthKeyFile = lib.mkOption {
      type = lib.types.path;
      description = "Secret Tailscale auth key scoped to tag:cf-ingress.";
    };

    apps = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule {
        options = {
          tunnel = {
            id = lib.mkOption {
              type = lib.types.strMatching "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
              description = "Cloudflare tunnel UUID.";
            };

            credentialsSecret = lib.mkOption {
              type = lib.types.str;
              description = "SOPS key containing this tunnel's credentials JSON.";
            };
          };

          route = {
            hostname = lib.mkOption {
              type = lib.types.str;
              description = "Exact public hostname accepted by this tunnel.";
            };

            service = lib.mkOption {
              type = lib.types.strMatching "https://.+";
              description = "Portable Tailscale Service URL used as the origin.";
            };

            originServerName = lib.mkOption {
              type = lib.types.str;
              description = "Tailscale Service DNS name expected in the origin certificate.";
            };
          };

          access.audienceTag = lib.mkOption {
            type = lib.types.strMatching "[0-9a-f]+";
            description = "Cloudflare Access application audience accepted by this connector.";
          };
        };
      });
      default = { };
      description = "Independently supervised public applications.";
    };

    access = {
      teamName = lib.mkOption {
        type = lib.types.str;
        description = "Cloudflare Access team name used to validate JWTs.";
      };

    };
  };

  config = lib.mkIf cfg.enable {
    sops.secrets = {
      tailscale_cf_ingress_auth_key = {
        owner = "root";
        mode = "0400";
      };
    } // appSecrets;

    networking.bridges.br-cloudflare.interfaces = [ ];
    networking.interfaces.br-cloudflare.ipv4.addresses = [
      {
        address = hostAddress;
        prefixLength = 24;
      }
    ];
    networking.nat = {
      enable = true;
      externalInterface = lib.mkDefault cfg.externalInterface;
      internalInterfaces = [ "br-cloudflare" ];
    };

    containers.cloudflare-ingress = {
      autoStart = true;
      privateNetwork = true;
      hostBridge = "br-cloudflare";
      inherit hostAddress;
      localAddress = "${containerAddress}/24";
      enableTun = true;
      bindMounts = {
        "/run/secrets/tailscale-auth-key" = {
          hostPath = cfg.tailscaleAuthKeyFile;
          isReadOnly = true;
        };
      } // appSecretMounts;

      config = { pkgs, ... }: {
        networking = {
          hostName = cfg.connectorName;
          useHostResolvConf = false;
          nameservers = [
            "100.100.100.100"
            "1.1.1.1"
          ];
        };

        services.tailscale = {
          enable = true;
          package = tailscalePackage;
          authKeyFile = "/run/secrets/tailscale-auth-key";
          extraUpFlags = [
            "--accept-dns=true"
            "--advertise-tags=tag:cf-ingress"
            "--hostname=${cfg.connectorName}"
          ];
        };

        systemd.services = appServices;

        system.stateVersion = "26.05";
      };
    };
  };
}
