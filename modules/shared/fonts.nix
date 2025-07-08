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
  } // lib.optionalAttrs (!pkgs.stdenv.isDarwin) {
    # Font configuration (Linux only - macOS uses different system)
    fontconfig = {
      enable = true;
      defaultFonts = {
        monospace = [ "Berkeley Mono" "JetBrainsMono Nerd Font" "DejaVu Sans Mono" ];
      };
      localConf = ''
        <?xml version="1.0"?>
        <!DOCTYPE fontconfig SYSTEM "fonts.dtd">
        <fontconfig>
          <!-- Force Berkeley Mono as the primary monospace font with strong binding -->
          <match target="pattern">
            <test qual="any" name="family">
              <string>monospace</string>
            </test>
            <edit name="family" mode="assign" binding="strong">
              <string>Berkeley Mono</string>
            </edit>
          </match>
          
          <!-- Override any existing monospace aliases -->
          <alias binding="strong">
            <family>monospace</family>
            <prefer>
              <family>Berkeley Mono</family>
              <family>JetBrainsMono Nerd Font</family>
              <family>DejaVu Sans Mono</family>
            </prefer>
          </alias>
          
          <!-- Directly match common monospace font requests -->
          <match target="pattern">
            <test qual="any" name="family">
              <string>mono</string>
            </test>
            <edit name="family" mode="assign" binding="strong">
              <string>Berkeley Mono</string>
            </edit>
          </match>
        </fontconfig>
      '';
    };
  };
}