{ lib, hostSystem ? null, pkgs, ... }:
let
  isLinux = hostSystem != null && lib.hasInfix "linux" hostSystem;
  isDarwin = hostSystem != null && lib.hasInfix "darwin" hostSystem;
  firewallAnchor = "com.apple/000.nix-darwin.tailnet-ssh";
  firewallRules = pkgs.writeText "tailnet-ssh-pf-anchor" ''
    pass in quick on lo0 inet proto tcp from 127.0.0.0/8 to 127.0.0.1 port 22 flags S/SA keep state
    pass in quick on lo0 inet6 proto tcp from ::1 to ::1 port 22 flags S/SA keep state
    block in quick inet proto tcp from urpf-failed to any port 22
    block in quick inet6 proto tcp from urpf-failed to any port 22
    pass in quick inet proto tcp from 100.64.0.0/10 to any port 22 flags S/SA keep state (if-bound)
    pass in quick inet6 proto tcp from fd7a:115c:a1e0::/48 to any port 22 flags S/SA keep state (if-bound)
    block in quick proto tcp from any to any port 22
  '';
  loadFirewall = pkgs.writeShellScript "load-tailnet-ssh-firewall" ''
    set -eu

    /sbin/pfctl -vnf ${firewallRules} >/dev/null
    /sbin/pfctl -a ${firewallAnchor} -f ${firewallRules}
    /sbin/pfctl -E >/dev/null
  '';
in
# On macOS, use the official Tailscale.app Network Extension rather than the
# nix-darwin tailscaled daemon; route-all/exit-node handling is more reliable.
lib.mkMerge [
  (lib.optionalAttrs isLinux {
    services.tailscale = {
      enable = true;
      extraUpFlags = lib.mkDefault [ "--ssh" ];
    };
  })

  (lib.optionalAttrs isDarwin {
    services.openssh = {
      enable = true;
      extraConfig = ''
        PermitRootLogin no
        PasswordAuthentication no
        KbdInteractiveAuthentication no
        AllowUsers bdsqqq@100.64.0.0/10 bdsqqq@fd7a:115c:a1e0::/48
      '';
    };

    # Apple's SSH launch socket listens on every interface. Keep remote access
    # tailnet-only while allowing local service discovery through loopback.
    launchd.daemons.tailnet-ssh-firewall = {
      command = "${loadFirewall}";
      serviceConfig = {
        Label = "dev.tailnet-ssh.firewall";
        RunAtLoad = true;
        KeepAlive.SuccessfulExit = false;
        ThrottleInterval = 10;
        StandardOutPath = "/var/log/tailnet-ssh-firewall.log";
        StandardErrorPath = "/var/log/tailnet-ssh-firewall.log";
      };
    };
  })
]
