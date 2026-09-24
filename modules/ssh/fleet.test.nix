{ lib }:
let
  generate = configurations: import ./fleet.nix { inherit lib configurations; };
  host = services: {
    config = {
      inherit services;
      networking.hostName = "remote";
      my.primaryUser = "operator";
    };
  };
  openSsh = host { openssh.enable = true; };
  tailscale = flags: host {
    tailscale = {
      enable = true;
      authKeyFile = "/run/secrets/tailscale";
      extraUpFlags = flags;
    };
  };
  actual = generate {
    linux = openSsh;
    darwin = lib.recursiveUpdate openSsh {
      config.networking = {
        hostName = "mini.local";
        localHostName = "mini";
      };
    };
    disabled = host { };
    vpnOnly = tailscale [ ];
    tailscaleSsh = tailscale [ "--ssh" ];
    explicitTrue = tailscale [ "--ssh=true" ];
    explicitFalse = tailscale [ "--ssh" "--ssh=false" ];
    setOverridesUp = lib.recursiveUpdate (tailscale [ "--ssh" ]) {
      config.services.tailscale.extraSetFlags = [ "--ssh=false" ];
    };
    stopped = lib.recursiveUpdate (tailscale [ "--ssh" ]) {
      config.services.tailscale.enable = false;
    };
    noAutoconnect = lib.recursiveUpdate (tailscale [ "--ssh" ]) {
      config.services.tailscale.authKeyFile = null;
    };
    setOnly = host {
      tailscale = {
        enable = true;
        extraSetFlags = [ "--ssh=true" ];
      };
    };
  };
  endpoint = { HostName = "remote"; User = "operator"; };
in
assert actual == {
  linux = endpoint;
  darwin = { HostName = "mini"; User = "operator"; };
  tailscaleSsh = endpoint;
  explicitTrue = endpoint;
  setOnly = endpoint;
};
true
