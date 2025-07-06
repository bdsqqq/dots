{ config, pkgs, lib, inputs, ... }:

{
  # Copy textfox CSS files to Firefox profile
  home.file = {
    ".mozilla/firefox/default/chrome/browser.css".source = "${inputs.textfox}/chrome/browser.css";
    ".mozilla/firefox/default/chrome/findbar.css".source = "${inputs.textfox}/chrome/findbar.css";
    ".mozilla/firefox/default/chrome/icons.css".source = "${inputs.textfox}/chrome/icons.css";
    ".mozilla/firefox/default/chrome/menus.css".source = "${inputs.textfox}/chrome/menus.css";
    ".mozilla/firefox/default/chrome/navbar.css".source = "${inputs.textfox}/chrome/navbar.css";
    ".mozilla/firefox/default/chrome/overwrites.css".source = "${inputs.textfox}/chrome/overwrites.css";
    ".mozilla/firefox/default/chrome/sidebar.css".source = "${inputs.textfox}/chrome/sidebar.css";
    ".mozilla/firefox/default/chrome/tabs.css".source = "${inputs.textfox}/chrome/tabs.css";
    ".mozilla/firefox/default/chrome/urlbar.css".source = "${inputs.textfox}/chrome/urlbar.css";
    ".mozilla/firefox/default/chrome/defaults.css".source = "${inputs.textfox}/chrome/defaults.css";
    ".mozilla/firefox/default/chrome/config.css".text = ''
      /* E-ink theme config */
      :root {
        --tf-font-family: "Inter", system-ui, sans-serif;
        --tf-font-size: 13px;
        --tf-text-transform: lowercase;
        --tf-display-titles: none; /* Hide section titles like "navbar", "main" etc. */
        --tf-border-width: 0px; /* Remove all borders */
        --tf-border: transparent; /* Make borders transparent */
        --tf-rounding: 4px; /* Keep slight rounding for aesthetics */
      }
    '';
  };

  programs.firefox = {
    enable = true;
    profiles.default = {
      name = "default";
      isDefault = true;
      
      # Textfox theme with e-ink colors
      userChrome = builtins.readFile "${inputs.textfox}/chrome/userChrome.css" + ''
        
        /* E-ink color scheme overrides */
        :root {
          --tf-bg: #101010 !important;
          --tf-fg: #c2c2c2 !important;
          --tf-accent: #7e7e7e !important;
          --tf-accent-secondary: #5a5a5a !important;
          --tf-border: #3a3a3a !important;
          --tf-sidebar-bg: #0a0a0a !important;
          --tf-tab-bg: #1a1a1a !important;
          --tf-tab-active-bg: #252525 !important;
          --tf-hover-bg: #2a2a2a !important;
          --tf-selected-bg: #303030 !important;
          --tf-shadow: rgba(0, 0, 0, 0.3) !important;
        }
        
        /* Ensure proper contrast */
        .tab-text, .bookmark-item, .menuitem-text {
          color: var(--tf-fg) !important;
        }
        
        /* Minimize visual noise */
        #nav-bar {
          border: none !important;
          box-shadow: none !important;
        }
        
        #urlbar {
          border: none !important;
          border-radius: 4px !important;
        }
        
        /* Hide section borders and labels */
        .section-header,
        .section-name,
        .section-title,
        .preferences-pane-header,
        .pane-header,
        h1, h2, h3, h4, h5, h6 {
          display: none !important;
        }
        
        /* Hide category labels in preferences */
        #categories .category[data-category] > .category-name,
        .category-name,
        .subcategory > h2,
        .subcategory > label,
        .groupbox-title,
        .groupbox > caption {
          display: none !important;
        }
      '';
      
      
      userContent = builtins.readFile "${inputs.textfox}/chrome/userContent.css" + ''
        
        /* Apply e-ink colors to web content backgrounds */
        @-moz-document url-prefix(about:) {
          html, body {
            background-color: #101010 !important;
            color: #c2c2c2 !important;
          }
        }
      '';
      
      settings = {
        # Enable userChrome.css
        "toolkit.legacyUserProfileCustomizations.stylesheets" = true;
        
        # Privacy and performance
        "privacy.trackingprotection.enabled" = true;
        "privacy.donottrackheader.enabled" = true;
        "browser.safebrowsing.malware.enabled" = true;
        "browser.safebrowsing.phishing.enabled" = true;
        
        # UI preferences for minimalist look
        "browser.tabs.tabClipWidth" = 83;
        "browser.tabs.tabMinWidth" = 76;
        "browser.urlbar.suggest.searches" = false;
        "browser.urlbar.showSearchSuggestionsFirst" = false;
        "browser.newtabpage.activity-stream.showSponsored" = false;
        "browser.newtabpage.activity-stream.showSponsoredTopSites" = false;
        "browser.newtabpage.activity-stream.default.sites" = "";
        
        # Smooth scrolling
        "general.smoothScroll" = true;
        "mousewheel.default.delta_multiplier_y" = 80;
        
        # Font rendering
        "gfx.webrender.all" = true;
        "layers.acceleration.force-enabled" = true;
      };
    };
  };
}