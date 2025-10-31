{ lib, pkgs, inputs, hostSystem ? null, ... }:
let
  spicePkgs = inputs.spicetify-nix.legacyPackages.${pkgs.stdenv.system};
in
{
  imports = [ inputs.spicetify-nix.homeManagerModules.default ];

  nixpkgs.config.allowUnfreePredicate = pkg: builtins.elem (lib.getName pkg) [
    "spotify"
  ];

  programs.spicetify = {
    enable = true;

    # Custom Vesper theme
    theme = {
      name = "Vesper";
      src = pkgs.fetchgit {
        url = "https://github.com/spicetify/spicetify-themes";
        rev = "c4b3c56"; # Update this to latest commit if needed
        sparseCheckout = [ "Vesper" ];
        hash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; # Replace with actual hash
      };
      appendName = true; # appends theme name to path
      injectCss = true;
      replaceColors = true;
      overwriteAssets = false;
      sidebarConfig = true;
      homeConfig = true;
    };

    # Vesper color scheme
    colorScheme = "vesper";
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

    # Geist Mono font + custom CSS from user.css + hover panel
    customCSS = ''
      @import url("https://fonts.googleapis.com/css2?family=Geist+Mono:wght@100..900&display=swap");

      * {
        font-family: "Geist mono", monospace !important;
      }

      .main-globalNav-searchSection {
        justify-content: flex-start;
        position: unset;
      }

      .e-9812-form-input-icon__icon {
        color: var(--spice-misc) !important;
        left: 14px !important;
      }

      .M9l40ptEBXPm03dU3X1k {
        height: 24px;
        width: 24px;
        padding: 0 !important;
      }

      .IYex0sXu8fnCz1FqFbRe {
        display: none;
      }

      .BV0jjn_h5TtMMl8YKuZ0 {
        display: none;
      }

      .GenericModal__overlay {
        padding-top: 8px;
        padding-left: 304px;
        background-color: unset;
        align-items: unset;
        justify-content: unset;
      }

      .N9tnwm0XDrt_eGJd2D2A {
        gap: 0.75rem;
        background-color: var(--spice-main-elevated);
        height: auto;
      }

      .zZMsUUWG29PYcwWPXhOV {
        padding: 0;
      }

      .search-modal-searchIcon {
        color: var(--spice-misc) !important;
      }

      .search-modal-searchBar {
        background-color: var(--spice-tab-active) !important;
      }

      .search-modal-input {
        color: var(--spice-text) !important;
      }

      .search-modal-keyboard-accessibility-bar {
        display: none;
      }
    '';

    # Snippets
    enabledSnippets = with spicePkgs.snippets; [
      # Official packaged snippets
      fixedEpisodesIcon
      fixDjIcon
      fixLikedIcon
      fixLikedButton
      fixNowPlayingIcon
      oneko
      prettyLyrics
      removeTopSpacing
      roundedImages
      
      # Hover panel (your custom one)
      ''
        :root {
          --ease-out-cubic: cubic-bezier(0.215, 0.61, 0.355, 1);
          --ease-in-out-cubic: cubic-bezier(0.645, 0.045, 0.355, 1);
          --hoverable-area: 16px;
        }
        
        #Desktop_LeftSidebar_Id {
          --offset: calc(calc(var(--left-sidebar-width) * 1px) - var(--hoverable-area));
          position: absolute;
          height: 100%;
          opacity: 0;
          left: calc(var(--offset) * -1);
          transition-property: left, opacity;
          transition-duration: 300ms;
          transition-timing-function: var(--ease-in-out-cubic);
          transition-delay: 150ms;
        }
        
        #Desktop_LeftSidebar_Id:focus-within,
        #Desktop_LeftSidebar_Id:has(.LayoutResizer__resize-bar--resizing),
        #Desktop_LeftSidebar_Id:hover {
          left: 0;
          opacity: 1;
          transition-duration: 150ms;
          transition-timing-function: var(--ease-out-cubic);
          transition-delay: 50ms;
        }
      ''
    ];

    # Custom apps
    enabledCustomApps = with spicePkgs.apps; [
      marketplace
    ];
  };
}
