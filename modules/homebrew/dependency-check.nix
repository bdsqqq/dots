{ lib, pkgs, homebrew }:
let
  brewfile = pkgs.writeText "Brewfile" homebrew.brewfile;
  environment = lib.concatStringsSep " " (
    lib.mapAttrsToList (name: value: "${name}=${lib.escapeShellArg value}") homebrew.onActivation.extraEnv
  );
in
''
  # sudo preserves cwd; the target user cannot traverse launchd's /var/root.
  cd /
  # nix-darwin's onlyCheck runs cleanup: unrelated native installs are NOT missing dependencies.
  PATH="${homebrew.prefix}/bin:${lib.makeBinPath [ pkgs.mas ]}:$PATH" \
    sudo --preserve-env=PATH --user=${lib.escapeShellArg homebrew.user} --set-home \
    env ${environment} HOMEBREW_NO_AUTO_UPDATE=1 \
    brew bundle check --no-upgrade --file=${lib.escapeShellArg brewfile}
''
