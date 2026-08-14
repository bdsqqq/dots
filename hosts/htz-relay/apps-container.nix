{
  config,
  ...
}:

{
  networking.nat = {
    enable = true;
    externalInterface = "enp1s0";
    internalInterfaces = [ "ve-apps" ];
  };

  containers.apps = {
    autoStart = true;
    privateNetwork = true;
    hostAddress = "10.233.1.1";
    localAddress = "10.233.1.2";
    enableTun = true;
    specialArgs.hostSystem = "x86_64-linux";
    bindMounts."/run/secrets/tailscale_auth_key" = {
      hostPath = config.sops.secrets.tailscale_auth_key.path;
      isReadOnly = true;
    };

    config = {
      networking = {
        hostName = "htz-apps";
        useHostResolvConf = false;
        nameservers = [ "1.1.1.1" "1.0.0.1" ];
      };

      services.tailscale = {
        enable = true;
        authKeyFile = "/run/secrets/tailscale_auth_key";
        openFirewall = true;
        extraUpFlags = [
          "--accept-dns=true"
          "--advertise-tags=tag:service-host"
          "--hostname=htz-apps"
        ];
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
