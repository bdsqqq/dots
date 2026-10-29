{ config, lib, ... }:
let
  user = config.system.primaryUser;
  home = config.users.users.${user}.home;
  configHome = config.home-manager.users.${user}.xdg.configHome;
in
{
  system.activationScripts.homebrew.text = lib.mkForce ''
    # launchd can create a missing log parent as root before Homebrew runs.
    # Repair only these directories, never ownership of their existing contents.
    for logs in ${lib.escapeShellArg "${home}/Library/Logs"} ${lib.escapeShellArg "${home}/Library/Logs/Homebrew"}; do
      mkdir -p "$logs"
      chown ${lib.escapeShellArg user} "$logs"
      chmod u+rwx "$logs"
    done

    repair_homebrew_trust() {
      local trust="$1" target temporary
      [ -L "$trust" ] || return 0
      target="$(readlink "$trust")"
      case "$target" in
        /nix/store/*-homebrew-trust.json)
          # Migrate only our legacy store link. Keep readable trust decisions;
          # a dangling link contains no data and must not block native writes.
          if [ -e "$trust" ]; then
            temporary="$(mktemp "$trust.XXXXXX")"
            cp "$trust" "$temporary"
            chown ${lib.escapeShellArg user} "$temporary"
            chmod 600 "$temporary"
            mv -f "$temporary" "$trust"
          else
            unlink "$trust"
          fi
          ;;
      esac
    }
    repair_homebrew_trust ${lib.escapeShellArg "${home}/.homebrew/trust.json"}
    repair_homebrew_trust ${lib.escapeShellArg "${configHome}/homebrew/trust.json"}
    unset -f repair_homebrew_trust

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
