# Shared font configuration for both Darwin and NixOS
{ config, pkgs, lib, inputs, ... }:

let
  berkeleyMono = pkgs.stdenv.mkDerivation {
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
  };
in
{
  fonts.packages = [
    berkeleyMono
    pkgs.nerd-fonts.jetbrains-mono
  ];
  
}