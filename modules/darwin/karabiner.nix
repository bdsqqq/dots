{ config, lib, pkgs, ... }:

let
  cfg = config.custom.karabiner;
  
  # Script to build and deploy karabiner configuration
  karabinerBuildScript = pkgs.writeShellScript "karabiner-build" ''
    set -e
    
    # Set PATH to include nix-managed node and pnpm
    export PATH="${pkgs.nodejs}/bin:${pkgs.pnpm}/bin:$PATH"
    
    KARABINER_SOURCE="/private/etc/nix-darwin/config/karabiner"
    KARABINER_CONFIG_DIR="/Users/bdsqqq/.config/karabiner"
    
    if [ ! -d "$KARABINER_SOURCE" ]; then
      echo "Karabiner source directory not found: $KARABINER_SOURCE"
      exit 1
    fi
    
    echo "Building karabiner configuration..."
    cd "$KARABINER_SOURCE"
    
    # Build the configuration using existing setup
    pnpm install --frozen-lockfile
    pnpm run build
    
    # Ensure config directory exists
    mkdir -p "$KARABINER_CONFIG_DIR"
    
    # Copy generated config
    if [ -f "$KARABINER_SOURCE/karabiner.json" ]; then
      cp "$KARABINER_SOURCE/karabiner.json" "$KARABINER_CONFIG_DIR/"
      echo "Karabiner configuration deployed successfully"
    else
      echo "Failed to generate karabiner.json"
      exit 1
    fi
    
    # Copy assets if they exist
    if [ -d "$KARABINER_SOURCE/assets" ]; then
      cp -r "$KARABINER_SOURCE/assets" "$KARABINER_CONFIG_DIR/"
    fi
  '';
  
  # LaunchD service to build and deploy karabiner config
  karabinerService = {
    script = ''
      ${karabinerBuildScript}
    '';
    
    serviceConfig = {
      Label = "com.bdsqqq.karabiner-build";
      RunAtLoad = true;
      StandardOutPath = "/tmp/karabiner-build.log";
      StandardErrorPath = "/tmp/karabiner-build.log";
    };
  };
in
{
  options.custom.karabiner = {
    enable = lib.mkEnableOption "karabiner-elements configuration management";
  };

  config = lib.mkIf cfg.enable {
    # Enable karabiner-elements via homebrew cask (still needed for the app itself)
    homebrew.casks = [ "karabiner-elements" ];
    
    # Create launchd service to build and deploy configuration
    launchd.user.agents.karabiner-build = karabinerService;
    
    # Add build script to PATH for manual rebuilds
    environment.systemPackages = [ 
      (pkgs.writeShellScriptBin "karabiner-rebuild" ''
        echo "Rebuilding karabiner configuration..."
        ${karabinerBuildScript}
      '')
    ];
  };
}
