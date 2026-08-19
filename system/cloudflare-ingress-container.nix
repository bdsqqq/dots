{ config, lib, pkgs, ... }:

let
  cfg = config.my.cloudflareIngress;
  containerAddress = "10.233.2.2";
  hostAddress = "10.233.2.1";
  tailscalePackage = pkgs.unstable.tailscale;
  tunnelConfig = pkgs.writeText "cloudflare-ingress.json" (builtins.toJSON {
    tunnel = cfg.tunnel.id;
    credentials-file = "/run/credentials/cloudflare-ingress.service/tunnel.json";
    ingress = [
      {
        inherit (cfg.route) hostname service;
        originRequest = {
          originServerName = cfg.route.originServerName;
          httpHostHeader = cfg.route.originServerName;
          access = {
            required = true;
            teamName = cfg.access.teamName;
            audTag = [ cfg.access.audienceTag ];
          };
        };
      }
      { service = "http_status:404"; }
    ];
  });
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

    tunnel = {
      id = lib.mkOption {
        type = lib.types.strMatching "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
        description = "Cloudflare tunnel UUID.";
      };

      credentialsFile = lib.mkOption {
        type = lib.types.path;
        description = "Secret tunnel-scoped Cloudflare credentials JSON.";
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

    access = {
      teamName = lib.mkOption {
        type = lib.types.str;
        description = "Cloudflare Access team name used to validate JWTs.";
      };

      audienceTag = lib.mkOption {
        type = lib.types.strMatching "[0-9a-f]+";
        description = "Cloudflare Access application audience accepted by the connector.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
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
        "/run/secrets/cloudflare-tunnel.json" = {
          hostPath = cfg.tunnel.credentialsFile;
          isReadOnly = true;
        };
      };

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

        systemd.services.cloudflare-ingress = {
          description = "Cloudflare ingress through a least-privilege tailnet identity";
          wantedBy = [ "multi-user.target" ];
          requires = [ "tailscaled-autoconnect.service" ];
          wants = [ "network-online.target" ];
          after = [
            "network-online.target"
            "tailscaled-autoconnect.service"
          ];
          serviceConfig = {
            DynamicUser = true;
            LoadCredential = "tunnel.json:/run/secrets/cloudflare-tunnel.json";
            ExecStart = lib.escapeShellArgs [
              "${pkgs.cloudflared}/bin/cloudflared"
              "tunnel"
              "--config=${tunnelConfig}"
              "--no-autoupdate"
              "run"
            ];
            Restart = "always";
            RestartSec = "5s";
            NoNewPrivileges = true;
            PrivateTmp = true;
            ProtectHome = true;
            ProtectSystem = "strict";
          };
        };

        system.stateVersion = "26.05";
      };
    };
  };
}
