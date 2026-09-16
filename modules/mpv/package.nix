{
  lib,
  pkgs,
}:

let
  isDarwin = pkgs.stdenv.hostPlatform.isDarwin;
  mpvPatch =
    commit: hash:
    pkgs.fetchpatch {
      url = "https://github.com/mpv-player/mpv/commit/${commit}.patch";
      inherit hash;
    };
  # nixpkgs' mpv 0.41 predates the macOS alpha-surface path. These are the
  # three commits from upstream PR #17173; drop them once nixpkgs includes it.
  mpv-unwrapped =
    if isDarwin then
      pkgs.mpv-unwrapped.overrideAttrs (old: {
        patches = (old.patches or [ ]) ++ [
          (mpvPatch "80448329045be1262c8b63fb05f8b60380adc8f7" "sha256-qr0CmNPTS37WgcBpMYA8yQ4PAAxv3i+zvVvm5Regpig=")
          (mpvPatch "4b4a291a28743fe3a364ce7e82e14f38c1d38b53" "sha256-WwY6O4LQNuH6JQWQX6CxCyvgN5g3K5del7ddU+OXPfQ=")
          (mpvPatch "13eca7a59de7ece3537f05ec9f325b74e909ef47" "sha256-hlnLZb081VtSjWRvSnpzJFF7S+iN1CYCrhfF/b3vHUY=")
        ];
      })
    else
      pkgs.mpv-unwrapped;
  # Thumbfast normally drops arbitrary lavfi graphs, which makes its previews
  # show the original green background instead of the transparent composition.
  thumbfast = pkgs.mpvScripts.thumbfast.overrideAttrs (old: {
    patches = (old.patches or [ ]) ++ [ ./thumbfast-preserve-lavfi.patch ];
  });
  thumbfastMpv =
    if isDarwin then
      "${mpv-unwrapped}/Applications/mpv.app/Contents/MacOS/mpv"
    else
      "${mpv-unwrapped}/bin/mpv";
  package = pkgs.mpv.override {
    inherit mpv-unwrapped;
    scripts = with pkgs.mpvScripts; [
      quality-menu
      thumbfast
      uosc
    ];
    extraMakeWrapperArgs = [
      "--add-flags"
      "--config-dir=${./config}"
      "--add-flags"
      "--osd-fonts-dir=${pkgs.mpvScripts.uosc}/share/fonts"
      "--add-flags"
      "--script-opts-append=thumbfast-mpv_path=${thumbfastMpv}"
    ];
  };
  transparentArgs = [
    "--vo=gpu-next"
    "--background=none"
    "--border-background=none"
    "--border=no"
    "--hwdec=no"
    "--keep-open=yes"
    "--vf=lavfi=[chromakey=0x00ff00:0.12:0.08,format=rgba,despill=type=green:mix=0.5:expand=0.15]"
  ]
  # The stable app id lets niri exempt alpha windows from its global opacity
  # and rounded-corner rule without affecting ordinary mpv windows.
  ++ lib.optionals (!isDarwin) [ "--wayland-app-id=mpv-transparent" ];
  transparentPackage = pkgs.writeShellApplication {
    name = "mpv-transparent";
    text = ''
      exec ${lib.getExe package} ${lib.escapeShellArgs transparentArgs} "$@"
    '';
  };
in
{
  inherit package transparentPackage;
}
