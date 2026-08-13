{ config, lib, ... }:
{
  system.activationScripts.homebrew.text = lib.mkForce ''
    # Homebrew manages mutable third-party packages. A broken cask should not
    # prevent nix-darwin and home-manager from activating the rest of the system.
    echo >&2 "Homebrew bundle..."
    if [ -f "${config.homebrew.prefix}/bin/brew" ]; then
      if ! ${config.homebrew.onActivation.brewBundleCmd { onlyCheck = false; }}; then
        printf >&2 '\e[1;33mwarning: Homebrew bundle failed; continuing system activation\e[0m\n'
      fi
    else
      printf >&2 '\e[1;33mwarning: Homebrew is not installed; continuing system activation\e[0m\n'
    fi
  '';
}
