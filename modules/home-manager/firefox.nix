{ config, pkgs, lib, ... }:

{
  programs.firefox = {
    enable = true;
    profiles.default = {
      name = "default";
      isDefault = true;
      
      # Textfox theme with e-ink colors
      userChrome = ''
        /* Import textfox theme */
        @import url("https://raw.githubusercontent.com/adriankarlen/textfox/main/chrome/userChrome.css");
        
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
          border: 1px solid var(--tf-border) !important;
          border-radius: 4px !important;
        }
      '';
      
      userContent = ''
        /* Import textfox content styles */
        @import url("https://raw.githubusercontent.com/adriankarlen/textfox/main/chrome/userContent.css");
        
        /* Apply e-ink colors to web content backgrounds */
        @-moz-document url-prefix(about:) {
          html, body {
            background-color: #101010 !important;
            color: #c2c2c2 !important;
          }
        }
      '';
      
      settings = {
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