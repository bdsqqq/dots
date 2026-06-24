{ config, lib, pkgs, hostSystem ? null, ... }:

if !(lib.hasInfix "darwin" hostSystem) then
  { }
else {
  # nix-darwin does not preserve arbitrary Homebrew env vars through sudo.
  system.activationScripts.homebrew.text = lib.mkForce ''
    # Homebrew Bundle
    echo >&2 "Homebrew bundle..."
    if [ -f "${config.homebrew.prefix}/bin/brew" ]; then
      PATH="${config.homebrew.prefix}/bin:${lib.makeBinPath [ pkgs.mas ]}:$PATH" \
      sudo \
        --preserve-env=PATH \
        --user=${lib.escapeShellArg config.homebrew.user} \
        --set-home \
        env HOMEBREW_NO_INSTALL_FROM_API=1 \
        ${config.homebrew.onActivation.brewBundleCmd}
    else
      echo -e "\e[1;31merror: Homebrew is not installed, skipping...\e[0m" >&2
    fi
  '';

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

