{ config, lib, pkgs, ... }:

let
  globalPackages = import ../../pnpm-global-packages.nix;
  
  # Create a package.json for our global packages
  packageJson = pkgs.writeText "package.json" (builtins.toJSON {
    name = "nix-pnpm-global";
    version = "1.0.0";
    dependencies = globalPackages;
  });
  
  # Create a pnpm-lock.yaml (this will need to be generated/updated manually)
  # For now, we'll use a simple approach with individual packages
  
  # Create individual package derivations
  mkGlobalPackage = name: version: pkgs.stdenv.mkDerivation {
    pname = "pnpm-global-${name}";
    version = "1.0.0";
    
    src = pkgs.runCommand "pnpm-global-${name}-src" {} ''
      mkdir -p $out
      cat > $out/package.json << EOF
      {
        "name": "nix-pnpm-global-${name}",
        "version": "1.0.0",
        "dependencies": {
          "${name}": "${version}"
        }
      }
      EOF
    '';
    
    nativeBuildInputs = [ pkgs.nodejs pkgs.pnpm ];
    
    configurePhase = ''
      export HOME=$TMPDIR
      export PNPM_HOME=$HOME/.pnpm
      export PATH=$PNPM_HOME:$PATH
      
      # Configure pnpm
      pnpm config set store-dir $TMPDIR/pnpm-store
      pnpm config set global-dir $out
      pnpm config set global-bin-dir $out/bin
    '';
    
    buildPhase = ''
      pnpm install --frozen-lockfile --production
    '';
    
    installPhase = ''
      mkdir -p $out/bin
      
      # Install the package globally to our output directory
      pnpm add -g ${name}@${version} --global-dir $out --global-bin-dir $out/bin
      
      # Create symlinks for binaries
      if [ -d "$out/bin" ]; then
        for bin in $out/bin/*; do
          if [ -f "$bin" ] && [ -x "$bin" ]; then
            echo "Found binary: $(basename $bin)"
          fi
        done
      fi
    '';
    
    meta = {
      description = "Global pnpm package: ${name}";
      platforms = pkgs.lib.platforms.all;
    };
  };
  
  # Alternative simpler approach: just use pnpm directly in a script
  pnpmGlobalInstaller = pkgs.writeShellScriptBin "install-pnpm-globals" ''
    set -e
    
    export PNPM_HOME="$HOME/Library/pnpm"
    export PATH="$PNPM_HOME:$PATH"
    
    echo "Installing global pnpm packages..."
    
    # Configure pnpm global directories
    ${pkgs.pnpm}/bin/pnpm config set global-dir "$PNPM_HOME"
    ${pkgs.pnpm}/bin/pnpm config set global-bin-dir "$PNPM_HOME"
    
    # Approve all build scripts globally to avoid warnings
    ${pkgs.pnpm}/bin/pnpm config set enable-pre-post-scripts true
    echo "y" | ${pkgs.pnpm}/bin/pnpm approve-builds -g || true
    
    # Install each package
    ${lib.concatStringsSep "\n" (lib.mapAttrsToList (name: version: 
      "${pkgs.pnpm}/bin/pnpm add -g ${name}@${version}"
    ) globalPackages)}
    
    echo "Global pnpm packages installed successfully!"
  '';
  
in
{
  # Add the installer script to packages
  home.packages = [ pnpmGlobalInstaller ];
  
  # Run the installer on activation
  home.activation = {
    installPnpmGlobals = lib.hm.dag.entryAfter ["writeBoundary"] ''
      echo "Setting up global pnpm packages..."
      ${pnpmGlobalInstaller}/bin/install-pnpm-globals
    '';
  };
  
  # Ensure the pnpm global directory is in PATH (already done in development.nix)
  # but we can add a check here
  home.sessionVariables = {
    PNPM_HOME = "$HOME/Library/pnpm";
  };
  
  # Add to PATH if not already there
  home.sessionPath = [
    "$PNPM_HOME"
  ];
}