{
  lib,
  pkgs,
}:

let
  isDarwin = pkgs.stdenv.hostPlatform.isDarwin;
  # 0.42 fixes coreaudio channel mapping on macOS 27 and includes the alpha
  # surface support previously backported here. keep the dependency bump local.
  libplacebo = pkgs.libplacebo.overrideAttrs {
    version = "7.387.0";
    src = pkgs.fetchFromGitLab {
      domain = "code.videolan.org";
      owner = "videolan";
      repo = "libplacebo";
      tag = "v7.387.0";
      hash = "sha256-PYi21y7uAZUsbn9nqn4ZP8QB9iQ9pRvnIKdOtG0WeIw=";
    };
  };
  mpv-unwrapped =
    if isDarwin then
      (pkgs.mpv-unwrapped.override { inherit libplacebo; }).overrideAttrs (old: {
        version = "0.42.0";
        src = pkgs.fetchFromGitHub {
          owner = "mpv-player";
          repo = "mpv";
          tag = "v0.42.0";
          hash = "sha256-kOVHFAuwGpV+Zz04FnzvjPq2tmEpvSDkHWUXoinEeSQ=";
        };
        postPatch =
          builtins.replaceStrings
            [ "meson.build_options())" ]
            [ ''meson.build_options().strip().replace('\\\\', '\\\\\\\\'))'' ]
            old.postPatch;
        buildInputs = old.buildInputs ++ [ pkgs.curl ];
        mesonFlags = old.mesonFlags ++ [ (lib.mesonEnable "libcurl" true) ];
        nativeBuildInputs = old.nativeBuildInputs ++ [ pkgs.rcodesign ];
        postFixup = (old.postFixup or "") + ''
          # rcodesign excludes git placeholders, but apple's verifier sees them
          # as unsealed additions. they serve no purpose in the installed app.
          find "$out/Applications/mpv.app" -name .gitkeep -delete
          rcodesign sign "$out/Applications/mpv.app"
          /usr/bin/codesign --verify --deep --strict "$out/Applications/mpv.app"
        '';
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
  wrapped = pkgs.mpv.override {
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
  # symlinkJoin replaces the app executable with a wrapper. seal a private,
  # fully materialized bundle after that replacement, not just the mach-o file.
  package =
    if isDarwin then
      wrapped.overrideAttrs (old: {
        nativeBuildInputs = old.nativeBuildInputs ++ [ pkgs.rcodesign ];
        buildCommand = old.buildCommand + ''
          cp -RL "$out/Applications/mpv.app" "$TMPDIR/mpv.app"
          chmod -R u+w "$TMPDIR/mpv.app"
          rm -r "$out/Applications/mpv.app"
          mv "$TMPDIR/mpv.app" "$out/Applications/mpv.app"
          rcodesign sign "$out/Applications/mpv.app"
          /usr/bin/codesign --verify --deep --strict "$out/Applications/mpv.app"
        '';
      })
    else
      wrapped;
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
