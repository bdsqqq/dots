{
  config,
  ...
}:

{
  networking.bridges.br-apps.interfaces = [ ];
  networking.interfaces.br-apps.ipv4.addresses = [
    {
      address = "10.233.1.1";
      prefixLength = 24;
    }
  ];
  networking.nat = {
    enable = true;
    externalInterface = "enp1s0";
    internalInterfaces = [ "br-apps" ];
  };

  containers.apps = {
    autoStart = true;
    privateNetwork = true;
    hostBridge = "br-apps";
    localAddress = "10.233.1.2/24";
    enableTun = true;
    specialArgs.hostSystem = "x86_64-linux";
    bindMounts."/run/secrets/tailscale_auth_key" = {
      hostPath = config.sops.secrets.tailscale_auth_key.path;
      isReadOnly = true;
    };

    config = { pkgs, ... }: {
      networking = {
        hostName = "htz-apps";
        useHostResolvConf = false;
        nameservers = [
          "1.1.1.1"
          "1.0.0.1"
        ];
      };

      services.tailscale = {
        enable = true;
        openFirewall = true;
      };
      systemd.services.tailscaled-autoconnect = {
        description = "enroll the app directory in tailscale";
        wantedBy = [ "multi-user.target" ];
        wants = [
          "network-online.target"
          "tailscaled.service"
        ];
        after = [
          "network-online.target"
          "tailscaled.service"
        ];
        serviceConfig.Type = "oneshot";
        script = ''
          ${pkgs.tailscale}/bin/tailscale up \
            --auth-key=file:/run/secrets/tailscale_auth_key \
            --accept-dns=true \
            --advertise-tags=tag:service-host \
            --hostname=htz-apps
        '';
      };

      imports = [ ../../system/tailnet-registry.nix ];
      my.tailnetRegistry.directory = {
        enable = true;
        tailscaleService.enable = true;
      };
      systemd.services.tailnet-registry = {
        wants = [ "tailscaled-autoconnect.service" ];
        after = [ "tailscaled-autoconnect.service" ];
      };

      system.stateVersion = "26.05";
    };
  };
}
