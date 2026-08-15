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
    bindMounts."/srv/html-stuff" = {
      hostPath = "/mnt/storage-01/commonplace/01_files/html_stuff";
      isReadOnly = true;
    };
    bindMounts."/srv/commonplace" = {
      hostPath = "/mnt/storage-01/commonplace";
      isReadOnly = true;
    };

    config =
      { pkgs, lib, ... }:
      let
        htmlStuffServer = import ../../user/html-stuff/package.nix {
          inherit pkgs;
        };
      in
      {
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
        my.tailnetRegistry.services.html-stuff = {
          title = "html stuff";
          description = "generated documents and visual artifacts";
          target = "http://127.0.0.1:8766";
          scheme = "http";
          port = 8765;
          healthPath = "/";
          access.tailnet = "owner";
          tailscaleService.enable = true;
        };
        my.tailnetRegistry.services.files = {
          title = "files";
          description = "read-only commonplace file browser";
          target = "http://127.0.0.1:3925";
          scheme = "https";
          port = 3925;
          healthPath = "/";
          access.tailnet = "owner";
          tailscaleService.enable = true;
        };

        users.users.bdsqqq = {
          isNormalUser = true;
          uid = 1000;
        };

        systemd.services.html-stuff = {
          description = "HTML artifact browser";
          wantedBy = [ "multi-user.target" ];
          serviceConfig = {
            ExecStart = "${htmlStuffServer}/bin/html-stuff-server --directory /srv/html-stuff --port 8766";
            Restart = "always";
            RestartSec = "5s";
            User = "bdsqqq";
          };
        };

        systemd.services.files-browser = {
          description = "Read-only commonplace file browser";
          wantedBy = [ "multi-user.target" ];
          serviceConfig = {
            ExecStart = lib.escapeShellArgs [
              "${pkgs.copyparty}/bin/copyparty"
              "-i"
              "127.0.0.1"
              "-p"
              "3925"
              "--hist"
              "/var/lib/files-browser"
              "--grid"
              "--no-del"
              "--no-mv"
              "-v"
              "/srv/commonplace::r"
            ];
            Restart = "always";
            RestartSec = "5s";
            User = "bdsqqq";
            StateDirectory = "files-browser";
            NoNewPrivileges = true;
            ProtectSystem = "strict";
            ProtectHome = true;
            ReadOnlyPaths = [ "/srv/commonplace" ];
          };
        };

        system.stateVersion = "26.05";
      };
  };

  systemd.services."container@apps" = {
    requires = [ "mnt-storage\\x2d01.mount" ];
    after = [ "mnt-storage\\x2d01.mount" ];
  };
}
