# Shared font configuration for both Darwin and NixOS
{ config, pkgs, lib, inputs, ... }:

{
  fonts = {
    packages = [
      # Berkeley Mono from local files
      (pkgs.stdenv.mkDerivation {
        pname = "berkeley-mono";
        version = "1.0.0";
        
        src = inputs.berkeley-mono;
        
        installPhase = ''
          mkdir -p $out/share/fonts/opentype/berkeley-mono
          cp *.otf $out/share/fonts/opentype/berkeley-mono/
        '';
        
        meta = {
          description = "Berkeley Mono - A love letter to the terminal";
          platforms = lib.platforms.all;
        };
      })
      
      # Fallback fonts
      pkgs.nerd-fonts.jetbrains-mono
    ];
    
    # Font configuration (Linux only - macOS handles this differently)
    fontconfig = lib.mkIf (!pkgs.stdenv.isDarwin) {
      enable = true;
      defaultFonts = {
        monospace = [ "Berkeley Mono" "JetBrainsMono Nerd Font" "DejaVu Sans Mono" ];
      };
      localConf = ''
        <?xml version="1.0"?>
        <!DOCTYPE fontconfig SYSTEM "fonts.dtd">
        <fontconfig>
          <alias>
            <family>monospace</family>
            <prefer>
              <family>Berkeley Mono</family>
              <family>JetBrainsMono Nerd Font</family>
              <family>DejaVu Sans Mono</family>
            </prefer>
          </alias>
        </fontconfig>
      '';
    };
  };
}