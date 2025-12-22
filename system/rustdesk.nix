# rustdesk over tailnet with direct IP access
# connect using tailscale IPs: r56=100.94.68.111, mbp-m2=100.87.59.2
# "unencrypted" warning is misleading — tailscale provides wireguard encryption
# see: https://tailscale.com/kb/1599/rustdesk
{ lib, pkgs, config, hostSystem ? null, ... }:
let
  system = hostSystem;
  isLinux = system != null && lib.hasInfix "linux" system;
  isDarwin = system != null && lib.hasInfix "darwin" system;
  
  homeDir = if isDarwin then "/Users/bdsqqq" else "/home/bdsqqq";
  
  flatpakAppId = "com.rustdesk.RustDesk";
  
  configPath = if isDarwin 
    then "Library/Preferences/com.carriez.RustDesk/RustDesk2.toml"
    else ".var/app/${flatpakAppId}/config/rustdesk/RustDesk2.toml";
  
  configDir = if isDarwin
    then "Library/Preferences/com.carriez.RustDesk"
    else ".var/app/${flatpakAppId}/config/rustdesk";

  pythonWithTomlkit = pkgs.python3.withPackages (ps: [ ps.tomlkit ]);
  
  mergeScript = pkgs.writeScript "rustdesk-config-merge" ''
    #!${pythonWithTomlkit}/bin/python3
    import sys
    import pathlib
    import tomlkit

    path = pathlib.Path(sys.argv[1])
    
    forced = {
        "direct-server": "Y",
        "direct-access-port": "21118",
        "whitelist": "100.64.0.0/10",
        "stop-service": "N",
    }

    if path.exists():
        try:
            data = tomlkit.loads(path.read_text())
        except Exception as e:
            print(f"warning: could not parse existing config ({e}), starting fresh")
            data = tomlkit.document()
    else:
        data = tomlkit.document()

    if "options" not in data:
        data["options"] = tomlkit.table()
    
    for k, v in forced.items():
        data["options"][k] = v

    path.write_text(tomlkit.dumps(data))
    print(f"merged rustdesk config at {path}")
  '';

  injectPasswordScript = pkgs.writeScript "rustdesk-inject-password" ''
    #!${pythonWithTomlkit}/bin/python3
    import sys
    import pathlib
    import tomlkit

    config_path = pathlib.Path(sys.argv[1])
    password = sys.argv[2]
    
    if not config_path.exists():
        print(f"config not found at {config_path}, skipping password injection")
        sys.exit(0)
    
    data = tomlkit.loads(config_path.read_text())
    if "options" not in data:
        data["options"] = tomlkit.table()
    data["options"]["permanent-password"] = password
    config_path.write_text(tomlkit.dumps(data))
    print(f"injected rustdesk password")
  '';

in
if isLinux then {
  services.flatpak.packages = [ flatpakAppId ];
  
  networking.firewall.interfaces."tailscale0".allowedTCPPorts = [ 21118 ];
  
  sops.secrets.rustdesk_password = {
    owner = "bdsqqq";
    group = "users";
  };
  
  home-manager.users.bdsqqq = { lib, config, ... }: {
    home.activation.rustdeskConfig = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      mkdir -p "${config.home.homeDirectory}/${configDir}"
      ${mergeScript} "${config.home.homeDirectory}/${configPath}"
    '';
  };
  
  systemd.services.rustdesk-password-inject = {
    description = "Inject RustDesk password from sops";
    wantedBy = [ "multi-user.target" ];
    after = [ "sops-install-secrets.service" ];
    serviceConfig = {
      Type = "oneshot";
      User = "bdsqqq";
      ExecStart = pkgs.writeShellScript "rustdesk-inject" ''
        PW=$(cat ${config.sops.secrets.rustdesk_password.path})
        ${injectPasswordScript} "${homeDir}/${configPath}" "$PW"
      '';
    };
  };
    
} else if isDarwin then {
  homebrew.casks = [ "rustdesk" ];
  
  sops.secrets.rustdesk_password = {
    owner = "bdsqqq";
  };
  
  home-manager.users.bdsqqq = { lib, config, ... }: {
    home.activation.rustdeskConfig = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      mkdir -p "${config.home.homeDirectory}/${configDir}"
      ${mergeScript} "${config.home.homeDirectory}/${configPath}"
    '';
  };
  
  launchd.daemons.rustdesk-password-inject = {
    script = ''
      PW=$(cat ${config.sops.secrets.rustdesk_password.path})
      ${injectPasswordScript} "${homeDir}/${configPath}" "$PW"
    '';
    serviceConfig = {
      Label = "com.rustdesk.password-inject";
      RunAtLoad = true;
      KeepAlive = false;
      UserName = "bdsqqq";
    };
  };
    
} else {}
