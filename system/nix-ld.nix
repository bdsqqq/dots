{ lib, pkgs, hostSystem ? null, ... }:
if !(lib.hasInfix "linux" hostSystem) then {} else {
  programs.nix-ld = {
    enable = true;
    libraries = with pkgs; [
      stdenv.cc.cc.lib
      zlib
      openssl
      curl
      glib
      nss
      nspr
      atk
      cups
      dbus
      libdrm
      gtk3
      pango
      cairo
      libX11
      libXcomposite
      libXdamage
      libXext
      libXfixes
      libXrandr
      libxcb
      mesa
      expat
      libxkbcommon
      alsa-lib
      icu
    ];
  };
}
