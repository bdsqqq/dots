{ lib, pkgs, inputs, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;

  # Vesper theme files (shared across platforms)
  vesperColorIni = ''
    [Vesper]
    text               = FFFFFF
    subtext            = A0A0A0
    main               = 101010
    main-elevated      = 101010
    highlight          = 161616
    highlight-elevated = 161616
    sidebar            = 101010
    player             = 101010
    card               = 161616
    shadow             = 101010
    selected-row       = FFFFFF
    button             = A0A0A0
    button-active      = FFC799
    button-disabled    = 505050
    tab-active         = 161616
    notification       = 101010
    notification-error = B54548
    misc               = 505050
  '';

  vesperUserCss = ''
    @import url("https://fonts.googleapis.com/css2?family=Geist+Mono:wght@100..900&display=swap");
    * { font-family: "Geist mono", monospace !important; }

    .main-globalNav-searchSection { justify-content: flex-start; position: unset; }
    .e-9812-form-input-icon__icon { color: var(--spice-misc) !important; left: 14px !important; }
    .M9l40ptEBXPm03dU3X1k { height: 24px; width: 24px; padding: 0 !important; }
    .IYex0sXu8fnCz1FqFbRe, .BV0jjn_h5TtMMl8YKuZ0 { display: none; }
    .GenericModal__overlay { padding-top: 8px; padding-left: 304px; background-color: unset; align-items: unset; justify-content: unset; }
    .N9tnwm0XDrt_eGJd2D2A { gap: 0.75rem; background-color: var(--spice-main-elevated); height: auto; }
    .zZMsUUWG29PYcwWPXhOV { padding: 0; }
    .search-modal-searchIcon { color: var(--spice-misc) !important; }
    .search-modal-searchBar { background-color: var(--spice-tab-active) !important; }
    .search-modal-input { color: var(--spice-text) !important; }
    .search-modal-keyboard-accessibility-bar { display: none; }
  '';

  hoverCss = ''
    :root {
      --ease-out-cubic: cubic-bezier(0.215, 0.61, 0.355, 1);
      --ease-in-out-cubic: cubic-bezier(0.645, 0.045, 0.355, 1);
      --hoverable-area: 16px;
    }
    #Desktop_LeftSidebar_Id {
      --offset: calc(calc(var(--left-sidebar-width) * 1px) - var(--hoverable-area));
      position: absolute; height: 100%; opacity: 0;
      left: calc(var(--offset) * -1);
      transition-property: left, opacity;
      transition-duration: 300ms;
      transition-timing-function: var(--ease-in-out-cubic);
      transition-delay: 150ms;
    }
    #Desktop_LeftSidebar_Id:focus-within,
    #Desktop_LeftSidebar_Id:has(.LayoutResizer__resize-bar--resizing),
    #Desktop_LeftSidebar_Id:hover {
      left: 0; opacity: 1;
      transition-duration: 150ms;
      transition-timing-function: var(--ease-out-cubic);
      transition-delay: 50ms;
    }
  '';

  vesperManifest = builtins.toJSON {
    name = "Vesper";
    description = "Peppermint and orange flavored dark theme for Spotify";
    preview = "vesper.png";
    readme = "README.md";
    usercss = "user.css";
    schemes = "color.ini";
    authors = [{ name = "bdsqqq"; url = "https://github.com/bdsqqq"; }];
    tags = ["dark" "minimal"];
  };
in
if isDarwin then {
  # Darwin: manual spicetify-cli + declarative theme files
  # (spicetify-nix darwin support is broken upstream)
  home-manager.users.bdsqqq = { lib, ... }: {
    home.packages = [ pkgs.spicetify-cli ];

    home.file = {
      ".config/spicetify/Themes/Vesper/color.ini".text = vesperColorIni;
      ".config/spicetify/Themes/Vesper/user.css".text = vesperUserCss + "\n\n" + hoverCss;
      ".config/spicetify/Themes/Vesper/manifest.json".text = vesperManifest;
    };

    home.activation.spicetify = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      if command -v spicetify >/dev/null 2>&1; then
        $DRY_RUN_CMD spicetify backup 2>/dev/null || true
        $DRY_RUN_CMD spicetify config current_theme Vesper
        $DRY_RUN_CMD spicetify config color_scheme Vesper
        $DRY_RUN_CMD spicetify config inject_css 1
        $DRY_RUN_CMD spicetify config replace_colors 1
        $DRY_RUN_CMD spicetify config custom_apps marketplace

        # Install marketplace if missing
        if [ ! -d "$HOME/.config/spicetify/CustomApps/marketplace" ]; then
          $VERBOSE_ECHO "Installing spicetify marketplace..."
          $DRY_RUN_CMD curl -fsSL https://raw.githubusercontent.com/spicetify/spicetify-marketplace/main/resources/install.sh | sh || true
        fi

        $DRY_RUN_CMD spicetify apply 2>/dev/null || true
      fi
    '';
  };
} else if isLinux then {
  # Linux: use spicetify-nix module
  nixpkgs.config.allowUnfreePredicate = pkg: builtins.elem (lib.getName pkg) [ "spotify" ];

  home-manager.users.bdsqqq = let
    spicePkgs = inputs.spicetify-nix.legacyPackages.${pkgs.system};

    vesperThemeDir = pkgs.runCommand "vesper-theme" {} ''
      mkdir -p $out
      cp ${pkgs.writeText "color.ini" vesperColorIni} $out/color.ini
      cp ${pkgs.writeText "user.css" (vesperUserCss + "\n\n" + hoverCss)} $out/user.css
      cp ${pkgs.writeText "manifest.json" vesperManifest} $out/manifest.json
    '';
  in {
    imports = [ inputs.spicetify-nix.homeManagerModules.default ];

    programs.spicetify = {
      enable = true;

      theme = {
        name = "Vesper";
        src = vesperThemeDir;
      };

      colorScheme = "Vesper";
      customColorScheme = {
        text = "FFFFFF";
        subtext = "A0A0A0";
        main = "101010";
        main-elevated = "101010";
        highlight = "161616";
        highlight-elevated = "161616";
        sidebar = "101010";
        player = "101010";
        card = "161616";
        shadow = "101010";
        selected-row = "FFFFFF";
        button = "A0A0A0";
        button-active = "FFC799";
        button-disabled = "505050";
        tab-active = "161616";
        notification = "101010";
        notification-error = "B54548";
        misc = "505050";
      };

      enabledSnippets = with spicePkgs.snippets; [
        fixedEpisodesIcon
        fixDjIcon
        fixLikedIcon
        fixLikedButton
        fixNowPlayingIcon
        prettyLyrics
        removeTopSpacing
        roundedImages
      ];

      enabledExtensions = with spicePkgs.extensions; [
        oneko
      ];

      enabledCustomApps = with spicePkgs.apps; [
        marketplace
      ];
    };
  };
} else {}
