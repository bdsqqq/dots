{ ... }:

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
    hostAddress = "10.233.1.1";
    localAddress = "10.233.1.2/24";
    enableTun = true;
    specialArgs.hostSystem = "x86_64-linux";

    config = {
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

      imports = [ ../../system/tailnet-registry.nix ];
      my.tailnetRegistry.directory = {
        enable = true;
        tailscaleService.enable = true;
      };

      system.stateVersion = "26.05";
    };
  };
}
