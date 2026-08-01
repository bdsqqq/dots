{ lib, pkgs, ... }:

let
  firewallAnchor = "com.apple/000.nix-darwin.moshi";
  firewallRules = pkgs.writeText "moshi-pf-anchor" ''
    block in quick inet proto tcp from urpf-failed to any port 22
    block in quick inet6 proto tcp from urpf-failed to any port 22
    pass in quick inet proto tcp from 100.64.0.0/10 to any port 22 flags S/SA keep state (if-bound)
    pass in quick inet6 proto tcp from fd7a:115c:a1e0::/48 to any port 22 flags S/SA keep state (if-bound)
    block in quick proto tcp from any to any port 22

    block in quick inet proto udp from urpf-failed to any port 60000:61000
    block in quick inet6 proto udp from urpf-failed to any port 60000:61000
    pass in quick inet proto udp from 100.64.0.0/10 to any port 60000:61000 keep state (if-bound)
    pass in quick inet6 proto udp from fd7a:115c:a1e0::/48 to any port 60000:61000 keep state (if-bound)
    block in quick proto udp from any to any port 60000:61000
  '';
  loadFirewall = pkgs.writeShellScript "load-moshi-firewall" ''
    set -eu

    /sbin/pfctl -vnf ${firewallRules} >/dev/null
    /sbin/pfctl -a ${firewallAnchor} -f ${firewallRules}
    /sbin/pfctl -E >/dev/null
  '';
  moshiCli = pkgs.writeShellScriptBin "moshi" ''
    exec -a moshi /opt/homebrew/opt/moshi-hook/bin/moshi-hook "$@"
  '';
  moshiHookCli = pkgs.writeShellScriptBin "moshi-hook" ''
    exec /opt/homebrew/opt/moshi-hook/bin/moshi-hook "$@"
  '';
in {
  homebrew = {
    taps = [ "rjyo/moshi" ];
    brews = [
      "mosh"
      {
        # moshi-hook also ships a conflicting `mosh` symlink. keep the formula
        # unlinked and expose only its two intended entry points below.
        name = "rjyo/moshi/moshi-hook";
        link = false;
      }
    ];
  };

  # moshi uses normal openssh over tailscale. keep key auth available for easy
  # pair, but reject authentication from outside tailscale's address ranges.
  services.openssh = {
    enable = true;
    extraConfig = ''
      PermitRootLogin no
      PasswordAuthentication no
      KbdInteractiveAuthentication no
      AllowUsers bdsqqq@100.64.0.0/10 bdsqqq@fd7a:115c:a1e0::/48
    '';
  };

  # apple's ssh launch socket and mosh-server otherwise listen on every
  # interface. this anchor is reached by /etc/pf.conf's com.apple/* anchor and
  # blocks both services before off-tailnet traffic reaches them.
  launchd.daemons.moshi-firewall = {
    command = "${loadFirewall}";
    serviceConfig = {
      Label = "dev.moshi.tailnet-firewall";
      RunAtLoad = true;
      KeepAlive.SuccessfulExit = false;
      ThrottleInterval = 10;
      StandardOutPath = "/var/log/moshi-firewall.log";
      StandardErrorPath = "/var/log/moshi-firewall.log";
    };
  };

  # mosh starts mosh-server through a non-interactive SSH shell, which does not
  # read .zshrc. make the homebrew binary visible during that bootstrap.
  home-manager.users.bdsqqq = {
    home.packages = [
      moshiCli
      moshiHookCli
    ];
    programs.zsh.envExtra = lib.mkAfter ''
      export PATH="/opt/homebrew/bin:$PATH"
    '';
  };
}
