{ config, lib, pkgs, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
  gpuVendors = lib.unique config.my.hardware.gpu.vendors;
  hasAmdGpu = lib.elem "amd" gpuVendors;
  hasIntelGpu = lib.elem "intel" gpuVendors;
  hasNvidiaGpu = lib.elem "nvidia" gpuVendors;

  wikimanPackage = pkgs.wikiman.overrideAttrs (oldAttrs: {
    postFixup = (oldAttrs.postFixup or "") + ''
      wrapProgram $out/bin/wikiman \
        --prefix PATH : "${lib.makeBinPath [ pkgs.findutils ]}"
    '';
  });

  wikimanUpdate = pkgs.writeShellApplication {
    name = "wikiman-update";
    runtimeInputs = [ pkgs.coreutils pkgs.curl pkgs.gnutar pkgs.jq ];
    text = ''
      set -euo pipefail

      data_home="''${XDG_DATA_HOME:-$HOME/.local/share}"
      state_home="''${XDG_STATE_HOME:-$HOME/.local/state}"
      doc_parent="$data_home/wikiman/share/doc"
      state_dir="$state_home/wikiman"
      target="$doc_parent/arch-wiki"
      url_file="$state_dir/arch-wiki.url"

      mkdir -p "$doc_parent" "$state_dir"

      latest_release="$(curl -fsSL -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/filiparag/wikiman/releases/latest")"
      url="$(printf '%s' "$latest_release" | jq -r '
        .assets[]
        | select(.name | test("^arch-wiki_[0-9]+\\.source\\.tar\\.xz$"))
        | .browser_download_url
      ' | sort | tail -n1)"

      if [ -z "$url" ]; then
        echo "wikiman-update: failed to resolve latest arch wiki snapshot" >&2
        exit 1
      fi

      if [ -d "$target/html" ] && [ -f "$url_file" ] && [ "$(cat "$url_file")" = "$url" ]; then
        echo "wikiman-update: arch wiki already current"
        exit 0
      fi

      tmp="$(mktemp -d)"
      trap 'rm -rf "$tmp"' EXIT

      curl -fL "$url" -o "$tmp/arch-wiki.tar.xz"
      mkdir -p "$tmp/next"
      tar --extract --file "$tmp/arch-wiki.tar.xz" --directory "$tmp/next" --strip-components=4 usr/share/doc/arch-wiki

      rm -rf "$target.previous"
      if [ -d "$target" ]; then
        mv "$target" "$target.previous"
      fi
      mv "$tmp/next" "$target"
      rm -rf "$target.previous"
      printf '%s\n' "$url" > "$url_file"

      echo "wikiman-update: installed $(basename "$url")"
    '';
  };
in {
  options.my.hardware.gpu.vendors = lib.mkOption {
    type = with lib.types; listOf (enum [ "amd" "intel" "nvidia" ]);
    default = [ ];
    description = ''
      gpu vendors present on this host.

      `dev-tools.nix` uses an explicit capability list here instead of
      inferring from `headMode` or `torchBackend`, which describe session
      shape and python package selection rather than gpu monitor tooling.
    '';
  };

  config.home-manager.users.bdsqqq = { config, pkgs, ... }: {
    xdg.configFile = {
      "wikiman/wikiman.conf".text = ''
        sources = man, arch
        fuzzy_finder = fzf
        wiki_lang = en
        tui_preview = true
        tui_source_column = true
        tui_html = w3m
      '';
      "wikiman/sources/arch.sh" = {
        executable = true;
        text = ''
          #!/bin/sh
          # arch wiki snapshots are user data, not nix inputs: a timer can refresh
          # them without waiting for a flake update or forcing a hash bump.
          conf_sys_usr="''${XDG_DATA_HOME:-$HOME/.local/share}/wikiman"
          . ${wikimanPackage}/share/wikiman/sources/arch.sh
        '';
      };
    };

    programs = {
      yt-dlp = {
        enable = true;
        settings = { sub-lang = "en.*"; };
      };
      gallery-dl.enable = true;
      tealdeer = {
        enable = true;
        enableAutoUpdates = true;
      };
    };
    home.packages = with pkgs;
      [
        coreutils
        exiftool
        sops
        age
        ssh-to-age
        fnm
        pnpm
        pscale
        ripgrep
        ast-grep
        fd
        bat
        eza
        btop
        ctop
        lazydocker
        curl
        wget
        jq
        yq
        tree
        tailscale
        p7zip
        cloc
        stow
        yazi
        tmux
        ffmpeg
        httpie
        fastfetch
        ollama
        mkcert
        wikimanPackage
        wikimanUpdate
      ] ++ lib.optionals isDarwin [
        istat-menus
        libimobiledevice
        ifuse
      ] ++ lib.optionals hasAmdGpu [ nvtopPackages.amd radeontop ]
      ++ lib.optionals hasIntelGpu [ nvtopPackages.intel ]
      ++ lib.optionals hasNvidiaGpu [ nvtopPackages.nvidia ];

    launchd.agents.wikiman-update = lib.mkIf isDarwin {
      enable = true;
      config = {
        ProgramArguments = [ "${wikimanUpdate}/bin/wikiman-update" ];
        RunAtLoad = true;
        StartCalendarInterval = [{
          Weekday = 1;
          Hour = 9;
          Minute = 0;
        }];
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/wikiman-update.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/wikiman-update.log";
      };
    };

    systemd.user.services.wikiman-update = lib.mkIf isLinux {
      Unit.Description = "Refresh Wikiman ArchWiki snapshot";
      Service = {
        Type = "oneshot";
        ExecStart = "${wikimanUpdate}/bin/wikiman-update";
      };
    };

    systemd.user.timers.wikiman-update = lib.mkIf isLinux {
      Unit.Description = "Weekly Wikiman ArchWiki refresh";
      Timer = {
        OnCalendar = "weekly";
        Persistent = true;
      };
      Install.WantedBy = [ "timers.target" ];
    };

    home.shellAliases = {
      b = "btop";
      f = "fastfetch";
    };
  };
}
