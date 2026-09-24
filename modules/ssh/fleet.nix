{ lib, configurations }:
let
  sshEnabled = config:
    let
      tailscale = config.services.tailscale or { };
      flags =
        lib.optionals ((tailscale.authKeyFile or null) != null)
          (tailscale.extraUpFlags or [ ])
        ++ (tailscale.extraSetFlags or [ ]);
      sshFlags = lib.filter
        (flag: flag == "--ssh" || lib.hasPrefix "--ssh=" flag)
        flags;
    in
    (config.services.openssh.enable or false)
    || ((tailscale.enable or false) && sshFlags != [ ]
      && builtins.elem (lib.last sshFlags) [ "--ssh" "--ssh=true" ]);
in
lib.mapAttrs
  (_: host: {
    # Darwin's hostName may end in .local; localHostName matches its tailnet name.
    HostName = host.config.networking.localHostName or host.config.networking.hostName;
    User = host.config.my.primaryUser;
  })
  (lib.filterAttrs (_: host: sshEnabled host.config) configurations)
