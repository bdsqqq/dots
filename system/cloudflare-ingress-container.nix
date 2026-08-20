{ config, inputs, lib, pkgs, tailnetApps, ... }:

let
  cfg = config.my.cloudflareIngress;
  runtimeBindings = builtins.fromJSON (
    builtins.readFile ../cloudflare/runtime-bindings.json
  );
  declaredApps = lib.filterAttrs
    (_: app:
      app.cloudflare != null
      && app.cloudflare.connectorTrust == cfg.trustClass)
    tailnetApps.catalog;
  apps = lib.mapAttrs
    (name: app:
      let
        binding = runtimeBindings.${name} or
          (throw "cloudflare app ${name} has no applied runtime binding");
        serviceHost = "${app.tailnet.service.name}.${cfg.tailnetDnsSuffix}";
      in
      {
        tunnel.id = binding.tunnelId;
        route = {
          inherit (app.cloudflare) hostname;
          service = "https://${serviceHost}";
          originServerName = serviceHost;
        };
        access = {
          audienceTag = binding.accessAudience;
          teamName = binding.accountTag;
        };
      })
    declaredApps;
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
              teamName = app.access.teamName;
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
  appSecretName = name: "cloudflare-tunnel-${name}";
  appSecrets = lib.mapAttrs'
    (name: _: lib.nameValuePair (appSecretName name) {
      sopsFile = inputs.self + "/secrets/cloudflare/${name}.yaml";
      key = "credential";
      owner = "root";
      mode = "0400";
    })
    apps;
  appSecretMounts = lib.mapAttrs'
    (name: _: lib.nameValuePair "/run/secrets/cloudflare-tunnel-${name}.json" {
      hostPath = config.sops.secrets.${appSecretName name}.path;
      isReadOnly = true;
    })
    apps;
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
    apps;
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

    trustClass = lib.mkOption {
      type = lib.types.strMatching "[a-z0-9][a-z0-9-]{0,63}";
      description = "App-declared connector trust class served by this relay.";
    };

    tailnetDnsSuffix = lib.mkOption {
      type = lib.types.str;
      default = "tail1543a7.ts.net";
      description = "Stable MagicDNS suffix used by portable Tailscale Services.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [{
      assertion = apps != { };
      message = "Cloudflare ingress trust class ${cfg.trustClass} has no published apps";
    }];

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
            "--advertise-tags=${tailnetApps.connectorTags.${cfg.trustClass}}"
            "--hostname=${cfg.connectorName}"
          ];
        };

        systemd.services = appServices;

        system.stateVersion = "26.05";
      };
    };
  };
}
