{
  config,
  lib,
  pkgs,
  headMode ? "graphical",
  ...
}:

let
  pluginIdentifier = "com.bdsqqq.transparent-player";
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
          --replace-fail '@mpv@' '${config.my.mpv.transparentPackage}/bin/mpv-transparent'

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
lib.mkIf (headMode == "graphical" && pkgs.stdenv.hostPlatform.isDarwin) {
  system.defaults.CustomUserPreferences."com.colliderli.iina" = {
    "PluginEnabled.${pluginIdentifier}" = true;
  };

  home-manager.users.bdsqqq =
    { ... }:
    {
      home.packages = [ pkgs.iina ];

      home.file."Library/Application Support/com.colliderli.iina/plugins/${pluginIdentifier}.iinaplugin" =
        {
          source = "${transparentPlayerPlugin}/${pluginIdentifier}.iinaplugin";
          recursive = true;
        };
    };
}
