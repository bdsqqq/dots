# Shared font configuration for both Darwin and NixOS
{ config, pkgs, lib, inputs, ... }:

let
  berkeleyMono = pkgs.stdenv.mkDerivation {
    pname = "berkeley-mono";
    version = "1.0.0";

    src = inputs.berkeley-mono;
    dontConfigure = true;
    dontBuild = true;

    installPhase = ''
      runHook preInstall
      mkdir -p $out/share/fonts/opentype/berkeley-mono
      for file in "$src"/*.otf; do
        install -m644 "$file" $out/share/fonts/opentype/berkeley-mono/
      done
      runHook postInstall
    '';

    meta = {
      description = "Berkeley Mono - a love letter to the terminal";
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
