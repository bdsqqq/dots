{ config, inputs, lib, pkgs, tailnetApps, ... }:

let
  cfg = config.my.cloudflareIngress;
  runtimeBindings = builtins.fromJSON (
    builtins.readFile ../../cloudflare/runtime-bindings.json
  );
  tailscalePackage = pkgs.unstable.tailscale;
  containerName = trust:
    if trust == "shared" then "cloudflare-ingress" else "cloudflare-ingress-${trust}";
  bridgeName = trust:
    if trust == "shared" then "br-cloudflare" else "br-cf-${trust}";
  hostAddress = connector: "10.233.${toString connector.networkId}.1";
  containerAddress = connector: "10.233.${toString connector.networkId}.2";
  authSecretName = trust: "cloudflare-connector-${trust}-tailscale-auth-key";
  authCredentialPath = trust:
    inputs.self + "/tailscale/secrets/connectors/${trust}.yaml";
  appSecretName = name: "cloudflare-tunnel-${name}";
  credentialPath = name: inputs.self + "/cloudflare/secrets/${name}.yaml";
  readyConnectors = lib.filterAttrs
    (trust: _: builtins.pathExists (authCredentialPath trust))
    cfg.connectors;
  readyApps = lib.filterAttrs
    (name: app:
      app.cloudflare != null
      && builtins.hasAttr name runtimeBindings
      && builtins.pathExists (credentialPath name))
    tailnetApps.catalog;
  declaredAppsFor = trust:
    lib.filterAttrs
      (_: app:
        app.cloudflare.connectorTrust == trust)
      readyApps;
  appsFor = trust:
    lib.mapAttrs
      (name: app:
        let
          binding = runtimeBindings.${name};
          declaredOrigin = app.cloudflare.origin or null;
          serviceHost = "${app.tailnet.service.name}.${cfg.tailnetDnsSuffix}";
        in
        {
          tunnel.id = binding.tunnelId;
          route = {
            inherit (app.cloudflare) hostname;
            service =
              if declaredOrigin == null
              then "https://${serviceHost}"
              else declaredOrigin.service;
            originServerName =
              if declaredOrigin == null
              then serviceHost
              else declaredOrigin.serverName;
          };
          access = {
            audienceTag = binding.accessAudience;
            teamName = binding.accountTag;
          };
        })
      (declaredAppsFor trust);
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
  appSecrets = lib.mapAttrs'
    (name: _: lib.nameValuePair (appSecretName name) {
      sopsFile = credentialPath name;
      key = "credential";
      owner = "root";
      mode = "0400";
    })
    readyApps;
  authSecrets = lib.mapAttrs'
    (trust: _: lib.nameValuePair (authSecretName trust) {
      sopsFile = authCredentialPath trust;
      key = "authKey";
      owner = "root";
      mode = "0400";
    })
    readyConnectors;
  appSecretMounts = apps:
    lib.mapAttrs'
      (name: _: lib.nameValuePair "/run/secrets/cloudflare-tunnel-${name}.json" {
        hostPath = config.sops.secrets.${appSecretName name}.path;
        isReadOnly = true;
      })
      apps;
  appServices = apps:
    lib.mapAttrs'
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
  mkContainer = trust: connector:
    let
      apps = appsFor trust;
    in
    {
      autoStart = true;
      privateNetwork = true;
      hostBridge = bridgeName trust;
      hostAddress = hostAddress connector;
      localAddress = "${containerAddress connector}/24";
      enableTun = true;
      bindMounts = {
        "/run/secrets/tailscale-auth-key" = {
          hostPath = config.sops.secrets.${authSecretName trust}.path;
          isReadOnly = true;
        };
      } // appSecretMounts apps;

      config = { pkgs, ... }: {
        networking = {
          hostName = connector.connectorName;
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
            "--advertise-tags=${tailnetApps.connectorTags.${trust}}"
            "--hostname=${connector.connectorName}"
          ];
        };

        systemd.services = appServices apps;

        system.stateVersion = "26.05";
      };
    };
  connectorType = lib.types.submodule {
    options = {
      connectorName = lib.mkOption {
        type = lib.types.strMatching "[a-z0-9][a-z0-9-]{0,62}";
        description = "Unique Tailscale hostname for this trust-class connector.";
      };

      networkId = lib.mkOption {
        type = lib.types.ints.between 2 254;
        description = "Third octet of the connector's isolated 10.233.x.0/24 network.";
      };
    };
  };
in
{
  options.my.cloudflareIngress = {
    enable = lib.mkEnableOption "isolated Cloudflare-to-tailnet connectors";

    externalInterface = lib.mkOption {
      type = lib.types.str;
      description = "Host interface used to NAT connector containers.";
    };

    connectors = lib.mkOption {
      type = lib.types.attrsOf connectorType;
      default = { };
      description = "Host participation in app-declared connector trust classes.";
    };

    tailnetDnsSuffix = lib.mkOption {
      type = lib.types.str;
      default = "tail1543a7.ts.net";
      description = "Stable MagicDNS suffix used by portable Tailscale Services.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.connectors != { };
        message = "Cloudflare ingress requires at least one connector trust class";
      }
      {
        assertion = builtins.length (lib.attrValues (lib.mapAttrs (_: value: value.networkId) cfg.connectors))
          == builtins.length (lib.unique (lib.attrValues (lib.mapAttrs (_: value: value.networkId) cfg.connectors)));
        message = "Cloudflare ingress connector network IDs must be unique";
      }
      {
        assertion = lib.all (trust: builtins.hasAttr trust tailnetApps.connectorTags)
          (builtins.attrNames cfg.connectors);
        message = "Cloudflare ingress connector trust classes must have generated Tailscale tags";
      }
    ];

    sops.secrets = authSecrets // appSecrets;

    networking.bridges = lib.mapAttrs'
      (trust: _: lib.nameValuePair (bridgeName trust) { interfaces = [ ]; })
      readyConnectors;
    networking.interfaces = lib.mapAttrs'
      (trust: connector: lib.nameValuePair (bridgeName trust) {
        ipv4.addresses = [{
          address = hostAddress connector;
          prefixLength = 24;
        }];
      })
      readyConnectors;
    networking.nat = {
      enable = true;
      externalInterface = lib.mkDefault cfg.externalInterface;
      internalInterfaces = map bridgeName (builtins.attrNames readyConnectors);
    };

    containers = lib.mapAttrs'
      (trust: connector: lib.nameValuePair (containerName trust) (mkContainer trust connector))
      readyConnectors;
  };
}
