{ lib, pkgs, hostSystem ? null, ... }:
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

in
if isLinux then {
  environment.systemPackages = [ pkgs.rustdesk ];
  
  # allow direct IP access port on tailscale interface only
  networking.firewall.interfaces."tailscale0".allowedTCPPorts = [ 21118 ];
  
  # merge config via home.activation (preserves rustdesk's dynamic values)
  # lib.hm only available inside home-manager user block
  home-manager.users.bdsqqq = { lib, config, ... }: {
    home.activation.rustdeskConfig = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      mkdir -p "${config.home.homeDirectory}/${configDir}"
      ${mergeScript} "${config.home.homeDirectory}/${configPath}"
    '';
  };
    
} else if isDarwin then {
  # use homebrew cask on darwin (nix package has platform detection issues)
  homebrew.casks = [ "rustdesk" ];
  
  # merge config via home.activation (preserves rustdesk's dynamic values)
  # macOS uses ~/Library/Preferences/com.carriez.RustDesk/RustDesk2.toml
  home-manager.users.bdsqqq = { lib, config, ... }: {
    home.activation.rustdeskConfig = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      mkdir -p "${config.home.homeDirectory}/${configDir}"
      ${mergeScript} "${config.home.homeDirectory}/${configPath}"
    '';
  };
    
} else {}
