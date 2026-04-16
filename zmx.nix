let
  overlay = final: prev:
    let
      version = "0.4.2";
      src = prev.fetchFromGitHub {
        owner = "neurosnap";
        repo = "zmx";
        rev = "v${version}";
        hash = "sha256-ehbriI3xW40oVUbokhNuxYvueqFhkmHCVNZpqxQLr3A=";
      };

      artifact =
        if final.stdenv.hostPlatform.isDarwin && final.stdenv.hostPlatform.isAarch64 then prev.fetchurl {
          url = "https://zmx.sh/a/zmx-0.4.2-macos-aarch64.tar.gz";
          hash = "sha256-V9SYOm6n7VwEt4ebkNQ0zCAtwLY3ysgK59WuCbQesWA=";
        }
        else if final.stdenv.hostPlatform.isDarwin && final.stdenv.hostPlatform.isx86_64 then prev.fetchurl {
          url = "https://zmx.sh/a/zmx-0.4.2-macos-x86_64.tar.gz";
          hash = "sha256-GunNG+i69eUaaci6kVZpip+DPgiRFmQoEbhaRE4mJ8c=";
        }
        else if final.stdenv.hostPlatform.isLinux && final.stdenv.hostPlatform.isAarch64 then prev.fetchurl {
          url = "https://zmx.sh/a/zmx-0.4.2-linux-aarch64.tar.gz";
          hash = "sha256-Lj/CpiV0CGJmNEgOWmhMwk5ys0+BPQiwCKNZ+VDvyjs=";
        }
        else if final.stdenv.hostPlatform.isLinux && final.stdenv.hostPlatform.isx86_64 then prev.fetchurl {
          url = "https://zmx.sh/a/zmx-0.4.2-linux-x86_64.tar.gz";
          hash = "sha256-JSPSkAbo4NdoyA9APK0pROkNWMuj9oqRJ3sLgNDB8jc=";
        }
        else throw "unsupported platform for zmx: ${final.stdenv.hostPlatform.system}";
    in {
      zmx = final.stdenv.mkDerivation {
        pname = "zmx";
        inherit version src;

        dontUnpack = true;

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/bin"
          tar -xzf "${artifact}" -C "$out/bin"
          chmod +x "$out/bin/zmx"
          runHook postInstall
        '';

        meta = with final.lib; {
          description = "session persistence for terminal processes";
          homepage = "https://github.com/neurosnap/zmx";
          changelog = "https://github.com/neurosnap/zmx/blob/v${version}/CHANGELOG.md";
          license = licenses.mit;
          mainProgram = "zmx";
          platforms = platforms.darwin ++ platforms.linux;
          sourceProvenance = [ sourceTypes.binaryNativeCode ];
        };
      };
    };

  module = {
    home-manager.users.bdsqqq = { lib, config, pkgs, ... }: {
      home.packages = [ pkgs.zmx ];
      home.sessionVariables.ZMX_DIR = "$HOME/.zmx";
      home.shellAliases = {
        zx = "zmx attach";
        zxl = "zmx list";
      };

      programs.zsh.initContent = lib.mkIf config.programs.zsh.enable ''
        # ctrl+s: fuzzy zmx session picker with live scrollback preview
        _zmx_list() {
          zmx list 2>/dev/null | awk -F '\t' '
            {
              name=$1; sub(/^session_name=/, "", name)
              pid=$2; sub(/^pid=/, "", pid)
              clients=$3; sub(/^clients=/, "", clients)
              dir=$5; sub(/^started_in=/, "", dir)
              printf "%-20s  pid:%-8s  clients:%-2s  %s\\n", name, pid, clients, dir
            }
          '
        }

        zmx-select() {
          local output query key selected session_name rc
          output=$(_zmx_list | fzf \
            --print-query \
            --expect=ctrl-n \
            --height=80% \
            --reverse \
            --border-label ' zmx ' \
            --prompt='zmx> ' \
            --header='  enter attach  ctrl+n new  ctrl+x kill' \
            --bind 'ctrl-x:execute-silent(zmx kill {1})+reload(_zmx_list)' \
            --preview='zmx history {1} 2>/dev/null' \
            --preview-window='right:60%:follow')
          rc=$?

          query=$(echo "$output" | sed -n '1p')
          key=$(echo "$output" | sed -n '2p')
          selected=$(echo "$output" | sed -n '3p')

          if [[ "$key" == 'ctrl-n' && -n "$query" ]]; then
            session_name="$query"
          elif [[ "$key" == 'ctrl-x' ]]; then
            return 0
          elif [[ $rc -eq 0 && -n "$selected" ]]; then
            session_name=$(echo "$selected" | awk '{print $1}')
          elif [[ -n "$query" ]]; then
            session_name="$query"
          else
            return 130
          fi

          zmx attach "$session_name"
        }

        _zmx_connect() {
          zmx-select
          zle reset-prompt
        }
        zle -N _zmx_connect
        bindkey '^s' _zmx_connect
      '';
    };
  };
in {
  inherit overlay module;
}
