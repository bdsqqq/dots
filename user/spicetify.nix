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

    # Marketplace snippets
    enabledSnippets = with spicePkgs.snippets; [
      # Built-in snippets (converted from marketplace)
      (builtins.toString spicePkgs.snippets.roundedImages or "")
      (builtins.toString spicePkgs.snippets.prettyLyrics or "")
      (builtins.toString spicePkgs.snippets.removeTopGradient or "")
    ] ++ [
      # Custom snippets from marketplace that might not be packaged
      
      # Fix Episodes Icon
      ''
        .main-yourEpisodesButton-yourEpisodesIcon { 
          background: var(--spice-text); 
          color: var(--spice-sidebar); 
        }
      ''
      
      # Fix DJ Icon
      ''
        .main-collectionLinkButton-icon > div { 
          background: var(--spice-text); 
          color: var(--spice-sidebar); 
        }
      ''
      
      # Fix Liked Icon
      ''
        .main-likedSongsButton-likedSongsIcon {
          color: var(--spice-sidebar);
          background: var(--spice-text);
        }
      ''
      
      # Fix Liked Button
      ''
        #_R_G *:not([fill="none"]) { fill: var(--spice-button) !important; } 
        #_R_G *:not([stroke="none"]) { stroke: var(--spice-button); } 
        .main-addButton-button[aria-checked="false"] { color: rgba(var(--spice-rgb-selected-row), 0.7); } 
        .control-button-heart[aria-checked="true"], .main-addButton-button, .main-addButton-active:focus, .main-addButton-active:hover { color: var(--spice-button); }
      ''
      
      # Fix now playing icon color
      ''
        .main-trackList-playingIcon { 
          -webkit-mask-image: url("data:image/svg+xml,%3Csvg id='playing-icon' xmlns='http://www.w3.org/2000/svg' viewBox='0 0 22 24'%3E%3Cdefs%3E%3Cstyle%3E %23playing-icon %7B fill: %2320BC54; %7D @keyframes play %7B 0%25 %7Btransform: scaleY(1);%7D 3.3%25 %7Btransform: scaleY(0.9583);%7D 6.6%25 %7Btransform: scaleY(0.9166);%7D 9.9%25 %7Btransform: scaleY(0.8333);%7D 13.3%25 %7Btransform: scaleY(0.7083);%7D 16.6%25 %7Btransform: scaleY(0.5416);%7D 19.9%25 %7Btransform: scaleY(0.4166);%7D 23.3%25 %7Btransform: scaleY(0.25);%7D 26.6%25 %7Btransform: scaleY(0.1666);%7D 29.9%25 %7Btransform: scaleY(0.125);%7D 33.3%25 %7Btransform: scaleY(0.125);%7D 36.6%25 %7Btransform: scaleY(0.1666);%7D 39.9%25 %7Btransform: scaleY(0.1666);%7D 43.3%25 %7Btransform: scaleY(0.2083);%7D 46.6%25 %7Btransform: scaleY(0.2916);%7D 49.9%25 %7Btransform: scaleY(0.375);%7D 53.3%25 %7Btransform: scaleY(0.5);%7D 56.6%25 %7Btransform: scaleY(0.5833);%7D 59.9%25 %7Btransform: scaleY(0.625);%7D 63.3%25 %7Btransform: scaleY(0.6666);%7D 66.6%25 %7Btransform: scaleY(0.6666);%7D 69.9%25 %7Btransform: scaleY(0.6666);%7D 73.3%25 %7Btransform: scaleY(0.6666);%7D 76.6%25 %7Btransform: scaleY(0.7083);%7D 79.9%25 %7Btransform: scaleY(0.75);%7D 83.3%25 %7Btransform: scaleY(0.8333);%7D 86.6%25 %7Btransform: scaleY(0.875);%7D 89.9%25 %7Btransform: scaleY(0.9166);%7D 93.3%25 %7Btransform: scaleY(0.9583);%7D 96.6%25 %7Btransform: scaleY(1);%7D %7D %23bar1 %7B transform-origin: bottom; animation: play 0.9s -0.51s infinite; %7D %23bar2 %7B transform-origin: bottom; animation: play 0.9s infinite; %7D %23bar3 %7B transform-origin: bottom; animation: play 0.9s -0.15s infinite; %7D %23bar4 %7B transform-origin: bottom; animation: play 0.9s -0.75s infinite; %7D %3C/style%3E%3C/defs%3E%3Ctitle%3Eplaying-icon%3C/title%3E%3Crect id='bar1' class='cls-1' width='4' height='24'/%3E%3Crect id='bar2' class='cls-1' x='6' width='4' height='24'/%3E%3Crect id='bar3' class='cls-1' x='12' width='4' height='24'/%3E%3Crect id='bar4' class='cls-1' x='18' width='4' height='24'/%3E%3C/svg%3E"); 
          background: var(--spice-button); 
          content-visibility: hidden; 
          -webkit-mask-repeat: no-repeat; 
        }
      ''
      
      # Remove Unused Space in Topbar
      ''
        .Kgjmt7IX5samBYUpbkBu { display: none !important; }
      ''
      
      # Oneko (cat on progress bar)
      ''
        .player-controls .playback-progressbar::before { 
          content: ''; 
          width: 32px; 
          height: 32px; 
          bottom: calc(100% - 7px); 
          right: 10px; 
          position: absolute; 
          image-rendering: pixelated; 
          background-image: url('https://raw.githubusercontent.com/adryd325/oneko.js/14bab15a755d0e35cd4ae19c931d96d306f99f42/oneko.gif'); 
          animation: oneko 1s infinite; 
        } 
        @keyframes oneko { 
          0%, 50% { background-position: -64px 0; } 
          50.0001%, 100% { background-position: -64px -32px; } 
        }
      ''
      
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
