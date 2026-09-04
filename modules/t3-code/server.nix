{ config
, hostSystem
, lib
, pkgs
, ...
}:
let
  isDarwin = lib.hasSuffix "-darwin" hostSystem;
  isLinux = lib.hasSuffix "-linux" hostSystem;
  toolsDir = "${config.my.paths.commonplace}/01_files/nix/modules/node-pnpm";
  toolsBin = "${toolsDir}/node_modules/.bin";
  developmentServer = "${config.users.users.bdsqqq.home}/.local/share/t3-pi/dist/bin.mjs";
  tailscaleServePort = if isDarwin then 8443 else 443;
  nativeRuntimePackages =
    if hostSystem == "aarch64-darwin" then
      [
        "@ff-labs/fff-bin-darwin-arm64"
        "@msgpackr-extract/msgpackr-extract-darwin-arm64"
        "@yuuang/ffi-rs-darwin-arm64"
      ]
    else if hostSystem == "x86_64-darwin" then
      [
        "@ff-labs/fff-bin-darwin-x64"
        "@msgpackr-extract/msgpackr-extract-darwin-x64"
        "@yuuang/ffi-rs-darwin-x64"
      ]
    else if hostSystem == "aarch64-linux" then
      [
        "@ff-labs/fff-bin-linux-arm64-gnu"
        "@msgpackr-extract/msgpackr-extract-linux-arm64"
        "@yuuang/ffi-rs-linux-arm64-gnu"
      ]
    else
      [
        "@ff-labs/fff-bin-linux-x64-gnu"
        "@msgpackr-extract/msgpackr-extract-linux-x64"
        "@yuuang/ffi-rs-linux-x64-gnu"
      ];
  t3Serve = pkgs.writeShellScript "t3-code-serve" ''
    set -eu

    if [ -f ${lib.escapeShellArg developmentServer} ]; then
      t3_command="${pkgs.nodejs}/bin/node ${developmentServer}"
    else
      t3_command="${toolsBin}/t3"
    fi

    exec $t3_command serve \
      --host 127.0.0.1 \
      --port 3773 \
      --no-browser
  '';
  t3Fork = pkgs.writeShellApplication {
    name = "t3-fork";
    runtimeInputs = [ pkgs.nodejs ];
    text = ''
      exec node ${lib.escapeShellArg developmentServer} "$@"
    '';
  };
  t3DeployPnpm = pkgs.pnpm.override {
    version = "11.10.0";
    hash = "sha256-YgtmBepPYvxWptCphzP0eQcdAyHgPkhrUix+mnRhdDE=";
  };
  t3PiDeploy = pkgs.writeShellApplication {
    name = "t3-pi-deploy";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.curl
      pkgs.gnused
      pkgs.git
      pkgs.nodejs
      t3DeployPnpm
    ];
    text = ''
      repo="''${T3CODE_FORK_DIR:-${config.my.paths.commonplace}/02_temp/t3code}"
      runtime_dir="$HOME/.local/share/t3-pi"
      mkdir -p "$runtime_dir"
      next="$(mktemp -d "$runtime_dir/.dist-next.XXXXXX")"
      previous="$runtime_dir/.dist-previous"
      replacement_installed=false
      previous_saved=false
      deployment_verified=false
      stage="setup"

      restart_service() {
        ${
          if isDarwin then
            ''launchctl kickstart -k "gui/$(id -u)/dev.t3-code.server"''
          else
            "systemctl restart t3-code.service"
        }
      }

      rollback() {
        set +e
        if [ "$replacement_installed" = true ]; then
          rm -rf "$runtime_dir/dist"
        fi
        if [ "$previous_saved" = true ] && [ -e "$previous" ]; then
          mv "$previous" "$runtime_dir/dist"
        fi
        restart_service
        set -e
      }

      cleanup() {
        status=$?
        trap - EXIT HUP INT TERM
        if [ "$status" -ne 0 ]; then
          printf 't3-pi-deploy failed during %s (exit %s)\n' "$stage" "$status" >&2
        fi
        if [ "$deployment_verified" != true ] && \
          { [ "$replacement_installed" = true ] || [ "$previous_saved" = true ]; }; then
          rollback
        fi
        rm -rf "$next"
        exit "$status"
      }
      trap cleanup EXIT
      trap 'exit 1' HUP INT TERM

      # Recover the last known-good deployment if an earlier process was killed
      # after the swap but before verification completed.
      if [ -e "$previous" ]; then
        rm -rf "$runtime_dir/dist"
        mv "$previous" "$runtime_dir/dist"
      fi

      stage="server build"
      test -x "$repo/node_modules/.bin/vp"
      (
        cd "$repo"
        ./node_modules/.bin/vp run --filter t3 build
      )

      stage="production package assembly"
      package="$next/.package"
      (
        cd "$repo"
        pnpm --filter t3 deploy --prod --legacy --no-optional --ignore-scripts "$package"
      )
      cp -R "$package/dist/." "$next/"
      mv "$package/node_modules" "$next/node_modules"
      rm -rf "$package"

      stage="native runtime staging"
      for native_package in ${lib.concatMapStringsSep " " lib.escapeShellArg nativeRuntimePackages}; do
        scope="''${native_package%%/*}"
        source="$repo/node_modules/.pnpm/node_modules/$native_package"
        if [ ! -e "$source" ]; then
          printf 'missing native runtime package %s at %s\n' "$native_package" "$source" >&2
          exit 1
        fi
        mkdir -p "$next/node_modules/$scope"
        cp -RL "$source" "$next/node_modules/$scope/"
      done

      ${lib.getExe pkgs.git} -C "$repo" rev-parse HEAD > "$next/source-revision"
      if ! ${lib.getExe pkgs.git} -C "$repo" diff --quiet; then
        printf '%s\n' dirty >> "$next/source-revision"
      fi

      stage="runtime swap"
      rm -rf "$previous"
      if [ -e "$runtime_dir/dist" ]; then
        previous_saved=true
        mv "$runtime_dir/dist" "$previous"
      fi
      replacement_installed=true
      mv "$next" "$runtime_dir/dist"

      stage="service restart"
      if ! restart_service; then
        exit 1
      fi

      stage="health check"
      ready=false
      for _ in $(seq 1 30); do
        if ${lib.getExe pkgs.curl} --fail --silent --max-time 1 \
          http://127.0.0.1:3773/.well-known/t3/environment >/dev/null; then
          ready=true
          break
        fi
        sleep 1
      done
      if [ "$ready" != true ]; then
        exit 1
      fi

      deployment_verified=true
      rm -rf "$previous"
      printf 'deployed %s\n' "$(cat "$runtime_dir/dist/source-revision")"
    '';
  };
in
if isLinux then
  {
    my.tailnetRegistry.services.t3-code = {
      title = "t3 code";
      description = "remote coding workspace";
      target = "http://127.0.0.1:3773";
      scheme = "https";
      port = tailscaleServePort;
      healthPath = "/.well-known/t3/environment";
      audience = "owner";
      adoptExisting = true;
    };

    environment.systemPackages = [
      t3Fork
      t3PiDeploy
    ];

    systemd.services.t3-code = {
      description = "T3 Code server";
      wantedBy = [ "multi-user.target" ];
      wants = [ "tailscaled.service" ];
      requires = [ "home-manager-bdsqqq.service" ];
      after = [
        "tailscaled.service"
        "home-manager-bdsqqq.service"
      ];
      restartTriggers = [
        ../node-pnpm/package.json
        ../node-pnpm/pnpm-lock.yaml
      ];

      environment.PATH = lib.mkForce "${toolsBin}:${lib.makeBinPath [
        pkgs.cloudflared
        pkgs.coreutils
        pkgs.git
        pkgs.gnused
        pkgs.nodejs
      ]}";
      serviceConfig = {
        Type = "exec";
        User = "bdsqqq";
        Group = "users";
        WorkingDirectory = "/home/bdsqqq";
        ExecStart = t3Serve;
        Restart = "always";
        RestartSec = "5s";
      };
    };
  }
else if isDarwin then
  {
    my.tailnetRegistry.services.t3-code = {
      title = "t3 code";
      description = "remote coding workspace";
      target = "http://127.0.0.1:3773";
      scheme = "https";
      port = tailscaleServePort;
      healthPath = "/.well-known/t3/environment";
      audience = "owner";
      adoptExisting = true;
    };

    environment.systemPackages = [
      t3Fork
      t3PiDeploy
    ];

    launchd.user.agents.t3-code = {
      path = [
        pkgs.coreutils
        pkgs.gnused
        pkgs.git
        pkgs.nodejs
        "/usr/local/bin"
        toolsBin
      ];
      command = t3Serve;
      serviceConfig = {
        Label = "dev.t3-code.server";
        RunAtLoad = true;
        KeepAlive = true;
        WorkingDirectory = "/Users/bdsqqq";
        StandardOutPath = "/Users/bdsqqq/Library/Logs/t3-code.log";
        StandardErrorPath = "/Users/bdsqqq/Library/Logs/t3-code-error.log";
      };
    };
  }
else
  { }
