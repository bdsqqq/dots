{ config, lib, pkgs, hostSystem ? null, ... }:

if !(lib.hasInfix "darwin" hostSystem) then
  { }
else
  let
    homebrewConfigHome = "/Users/${config.homebrew.user}/.config";
    homebrewTrustJson = builtins.toJSON {
      trustedtaps = [ "pluk-inc/tap" ];
      trustedcasks = [ "pluk-inc/tap/markdown-preview" ];
    };
    homebrewTrustFile = pkgs.writeText "homebrew-trust.json" homebrewTrustJson;
  in
  {
    # nix-darwin does not preserve arbitrary Homebrew env vars through sudo.
    system.activationScripts.homebrew.text = lib.mkForce ''
      # Homebrew Bundle
      echo >&2 "Homebrew bundle..."
      if [ -f "${config.homebrew.prefix}/bin/brew" ]; then
        homebrew_config_home=${lib.escapeShellArg homebrewConfigHome}
        mkdir -p "$homebrew_config_home/homebrew"
        chown ${lib.escapeShellArg config.homebrew.user}:staff "$homebrew_config_home" "$homebrew_config_home/homebrew"
        rm -f "$homebrew_config_home/homebrew/trust.json"
        ln -s ${homebrewTrustFile} "$homebrew_config_home/homebrew/trust.json"
        chown -h ${lib.escapeShellArg config.homebrew.user}:staff "$homebrew_config_home/homebrew/trust.json"

        export PATH="${config.homebrew.prefix}/bin:${lib.makeBinPath [ pkgs.mas ]}:$PATH"
        sudo \
          --preserve-env=PATH \
          --user=${lib.escapeShellArg config.homebrew.user} \
          --set-home \
          env \
            HOMEBREW_NO_INSTALL_FROM_API=1 \
            XDG_CONFIG_HOME=${lib.escapeShellArg homebrewConfigHome} \
            ${config.homebrew.onActivation.brewBundleCmd { onlyCheck = false; }}
      else
        echo -e "\e[1;31merror: Homebrew is not installed, skipping...\e[0m" >&2
      fi
    '';

    home-manager.users.bdsqqq.xdg.configFile."homebrew/trust.json" = {
      source = homebrewTrustFile;
      force = true;
    };

    homebrew = {
      enable = true;

      taps = [
        "homebrew/cask"
        "pluk-inc/tap"
      ];

      casks = [
        # System utilities
        "handy"
        "cleanshot"
        "tailscale"

        # Development tools
        "tableplus"

        # Creative/Media tools
        "figma"
        "obs"

        # Productivity applications
        "linear"
        "markdown-preview"
        "notion-calendar"
        "notion"

        # Entertainment/Gaming
        "steam"
      ];

      onActivation = {
        autoUpdate = false;
        upgrade = true;
      };
    };
  }
