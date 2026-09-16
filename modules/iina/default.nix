{
  lib,
  pkgs,
  hostSystem ? null,
  headMode ? "graphical",
  ...
}:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  pluginIdentifier = "com.bdsqqq.transparent-player";
  mpvPatch =
    commit: hash:
    pkgs.fetchpatch {
      url = "https://github.com/mpv-player/mpv/commit/${commit}.patch";
      inherit hash;
    };
  # nixpkgs' mpv 0.41 predates the macOS alpha-surface path. These are the
  # three commits from upstream PR #17173; drop them once nixpkgs includes it.
  patchedMpvUnwrapped = pkgs.mpv-unwrapped.overrideAttrs (old: {
    patches = (old.patches or [ ]) ++ [
      (mpvPatch "80448329045be1262c8b63fb05f8b60380adc8f7" "sha256-qr0CmNPTS37WgcBpMYA8yQ4PAAxv3i+zvVvm5Regpig=")
      (mpvPatch "4b4a291a28743fe3a364ce7e82e14f38c1d38b53" "sha256-WwY6O4LQNuH6JQWQX6CxCyvgN5g3K5del7ddU+OXPfQ=")
      (mpvPatch "13eca7a59de7ece3537f05ec9f325b74e909ef47" "sha256-hlnLZb081VtSjWRvSnpzJFF7S+iN1CYCrhfF/b3vHUY=")
    ];
  });
  patchedMpv = pkgs.mpv.override {
    mpv-unwrapped = patchedMpvUnwrapped;
  };
  # Thumbfast normally drops arbitrary lavfi graphs, which makes its previews
  # show the original green background instead of the transparent composition.
  transparentThumbfast = pkgs.mpvScripts.thumbfast.overrideAttrs (old: {
    patches = (old.patches or [ ]) ++ [ ./thumbfast-preserve-lavfi.patch ];
  });
  transparentMpv = pkgs.mpv.override {
    mpv-unwrapped = patchedMpvUnwrapped;
    scripts = with pkgs.mpvScripts; [
      quality-menu
      transparentThumbfast
      uosc
    ];
    # Keep the transparent player polished without inheriting or mutating the
    # user's regular mpv setup.
    extraMakeWrapperArgs = [
      "--add-flags"
      "--config-dir=${./transparent-player.mpv}"
      "--add-flags"
      "--osd-fonts-dir=${pkgs.mpvScripts.uosc}/share/fonts"
      "--add-flags"
      "--script-opts-append=thumbfast-mpv_path=${patchedMpvUnwrapped}/Applications/mpv.app/Contents/MacOS/mpv"
    ];
  };
  transparentPlayerPlugin =
    pkgs.runCommand "iina-transparent-player-plugin-1.0.0"
      {
        nativeBuildInputs = [
          pkgs.jq
          pkgs.nodejs
        ];
      }
      ''
        plugin="$out/${pluginIdentifier}.iinaplugin"
        mkdir -p "$plugin"

        cp ${./transparent-player.iinaplugin/Info.json} "$plugin/Info.json"
        substitute ${./transparent-player.iinaplugin/main.js} "$plugin/main.js" \
          --replace-fail '@mpv@' '${transparentMpv}/bin/mpv'

        jq --exit-status '
          .identifier == "${pluginIdentifier}"
          and .entry == "main.js"
          and (.permissions | index("file-system"))
          and (.permissions | index("show-osd"))
        ' "$plugin/Info.json" >/dev/null
        node --check "$plugin/main.js"
        IINA_PLUGIN_MAIN="$plugin/main.js" \
          node --test ${./transparent-player.iinaplugin/main.test.js}
      '';
in
lib.mkIf (headMode == "graphical" && isDarwin) {
  system.defaults.CustomUserPreferences."com.colliderli.iina" = {
    "PluginEnabled.${pluginIdentifier}" = true;
  };

  home-manager.users.bdsqqq =
    { ... }:
    {
      home.packages = [
        pkgs.iina
        patchedMpv
      ];

      home.file."Library/Application Support/com.colliderli.iina/plugins/${pluginIdentifier}.iinaplugin" =
        {
          source = "${transparentPlayerPlugin}/${pluginIdentifier}.iinaplugin";
          recursive = true;
        };
    };
}
