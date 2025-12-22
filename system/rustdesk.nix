{ lib, pkgs, config, hostSystem ? null, ... }:
let
  system = hostSystem;
  isLinux = system != null && lib.hasInfix "linux" system;
  isDarwin = system != null && lib.hasInfix "darwin" system;
  
  # platform-specific config paths
  configPath = if isDarwin 
    then "Library/Preferences/com.carriez.RustDesk/RustDesk2.toml"
    else ".config/rustdesk/RustDesk2.toml";
  
  configDir = if isDarwin
    then "Library/Preferences/com.carriez.RustDesk"
    else ".config/rustdesk";

  pythonWithTomlkit = pkgs.python3.withPackages (ps: [ ps.tomlkit ]);
  
  # python merge script - preserves rustdesk's dynamic values AND formatting/comments
  mergeScript = pkgs.writeScript "rustdesk-config-merge" ''
    #!${pythonWithTomlkit}/bin/python3
    import sys
    import pathlib
    import tomlkit

    path = pathlib.Path(sys.argv[1])
    
    # forced options from nix
    forced = {
        "direct-server": "Y",
        "direct-access-port": "21118",
        "whitelist": "100.64.0.0/10",
        "stop-service": "N",  # required for direct-server to listen
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

  # password injection script - separate from merge to handle sops timing
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
  environment.systemPackages = [ pkgs.rustdesk ];
  
  # allow direct IP access port on tailscale interface only
  networking.firewall.interfaces."tailscale0".allowedTCPPorts = [ 21118 ];
  
  # declare sops secret for rustdesk password
  sops.secrets.rustdesk_password = {
    owner = "bdsqqq";
    group = "users";
  };
  
  # merge config via home.activation (preserves rustdesk's dynamic values)
  home-manager.users.bdsqqq = { lib, config, ... }: {
    home.activation.rustdeskConfig = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      mkdir -p "${config.home.homeDirectory}/${configDir}"
      ${mergeScript} "${config.home.homeDirectory}/${configPath}"
      
      # inject password from sops secret
      SOPS_PW_FILE="/run/secrets/rustdesk_password"
      if [ -r "$SOPS_PW_FILE" ]; then
        PW=$(cat "$SOPS_PW_FILE")
        ${injectPasswordScript} "${config.home.homeDirectory}/${configPath}" "$PW"
      else
        echo "warning: sops rustdesk_password not available, skipping password injection"
      fi
    '';
  };
    
} else if isDarwin then {
  # use homebrew cask on darwin (nix package has platform detection issues)
  homebrew.casks = [ "rustdesk" ];
  
  # declare sops secret for rustdesk password
  sops.secrets.rustdesk_password = {
    owner = "bdsqqq";
  };
  
  # merge config via home.activation (preserves rustdesk's dynamic values)
  home-manager.users.bdsqqq = { lib, config, ... }: {
    home.activation.rustdeskConfig = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      mkdir -p "${config.home.homeDirectory}/${configDir}"
      ${mergeScript} "${config.home.homeDirectory}/${configPath}"
      
      # inject password from sops secret
      SOPS_PW_FILE="/run/secrets/rustdesk_password"
      if [ -r "$SOPS_PW_FILE" ]; then
        PW=$(cat "$SOPS_PW_FILE")
        ${injectPasswordScript} "${config.home.homeDirectory}/${configPath}" "$PW"
      else
        echo "warning: sops rustdesk_password not available, skipping password injection"
      fi
    '';
  };
    
} else {}
