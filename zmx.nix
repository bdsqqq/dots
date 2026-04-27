let
  overlay =
    final: prev:
    let
      version = "0.5.0";
      src = prev.fetchFromGitHub {
        owner = "neurosnap";
        repo = "zmx";
        rev = "v${version}";
        hash = "sha256-eVp9Lgpx4Dn60NH17zZ+VOUy1VVK73A17bIkPFDKuz4=";
      };

      artifact =
        if final.stdenv.hostPlatform.isDarwin && final.stdenv.hostPlatform.isAarch64 then
          prev.fetchurl {
            url = "https://zmx.sh/a/zmx-${version}-macos-aarch64.tar.gz";
            hash = "sha256-O5N58P8M8Qf3+HBI0sRfb76r7ViNZ2rYasIYvtko0Qc=";
          }
        else if final.stdenv.hostPlatform.isDarwin && final.stdenv.hostPlatform.isx86_64 then
          prev.fetchurl {
            url = "https://zmx.sh/a/zmx-${version}-macos-x86_64.tar.gz";
            hash = "sha256-d27kjv1Q0L2Xtm+ktDA6JmKVwKDhYwRbc6xmJo1XgbY=";
          }
        else if final.stdenv.hostPlatform.isLinux && final.stdenv.hostPlatform.isAarch64 then
          prev.fetchurl {
            url = "https://zmx.sh/a/zmx-${version}-linux-aarch64.tar.gz";
            hash = "sha256-youXaIO9bdahR9kUD9b2JewpEMs6chCCGksoWND8nVw=";
          }
        else if final.stdenv.hostPlatform.isLinux && final.stdenv.hostPlatform.isx86_64 then
          prev.fetchurl {
            url = "https://zmx.sh/a/zmx-${version}-linux-x86_64.tar.gz";
            hash = "sha256-TMH2uFTczcq65MuRvQN5oj5vghAEivXYHgZh5ZSlDCg=";
          }
        else
          throw "unsupported platform for zmx: ${final.stdenv.hostPlatform.system}";
    in
    {
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
          # upstream ships per-platform release artifacts; this wrapper keeps the
          # nix build small instead of compiling zmx from source on every host.
          sourceProvenance = [ sourceTypes.binaryNativeCode ];
        };
      };
    };

  module = {
    home-manager.users.bdsqqq =
      {
        lib,
        config,
        pkgs,
        ...
      }:
      let
        # fzf reloads run in a child shell, so they cannot see zsh functions from
        # initContent. keep list parsing in a real command used by both zsh and fzf.
        # zmx 0.5.0 emits name=/start_dir=; older builds used
        # session_name=/started_in=, so parse by key instead of column position.
        zmxRows = pkgs.writeShellApplication {
          name = "zmx-rows";
          runtimeInputs = [ pkgs.zmx ];
          text = ''
            zmx list 2>/dev/null | awk -F '\t' '
              {
                delete f
                for (i = 1; i <= NF; i++) {
                  key = $i
                  val = $i
                  sub("=.*", "", key)
                  sub("^[^=]*=", "", val)
                  f[key] = val
                }
                name = f["name"] ? f["name"] : f["session_name"]
                dir = f["start_dir"] ? f["start_dir"] : f["started_in"]
                if (name != "") printf "%s\tclients:%s\tpid:%s\tcreated:%s\t%s\n", name, f["clients"], f["pid"], f["created"], dir
              }
            ' | sort -t $'\t' -k1,1
          '';
        };
      in
      {
        home.packages = [
          pkgs.zmx
          zmxRows
        ];
        home.sessionVariables.ZMX_DIR = "$HOME/.zmx";

        programs.zsh.initContent = lib.mkIf config.programs.zsh.enable ''
          # stable names matter because agents refer to sessions by mention-like
          # paths, e.g. @zmx/nix.build. keep the grammar conservative so shell
          # snippets, fzf placeholders, and future mention resolvers agree.
          _zmx_sanitize() {
            printf '%s' "$*" \
              | tr '[:upper:]' '[:lower:]' \
              | sed -E 's#[/[:space:]]+#-#g; s#[^a-z0-9._-]+##g; s#[-.]+$##; s#^[-.]+##'
          }

          _zmx_root() {
            local root name
            root=$(git rev-parse --show-toplevel 2>/dev/null) || root=$PWD
            name=''${root:t}
            _zmx_sanitize "$name"
          }

          # child creation is only scoped after zmx has injected ZMX_SESSION.
          # outside zmx, `zx scratch` stays literal to avoid surprise repo.scratch names.
          _zmx_child_name() {
            local child
            child=$(_zmx_sanitize "$1")
            printf '%s.%s\n' "$ZMX_SESSION" "$child"
          }

          _zmx_rows() {
            zmx-rows
          }

          # inside a session, picker default should show local children first;
          # ctrl+a still exposes the full graph for cross-project jumps.
          _zmx_scoped_rows() {
            if [[ -n "$ZMX_SESSION" ]]; then
              _zmx_rows | awk -F '\t' -v prefix="$ZMX_SESSION." 'index($1, prefix) == 1'
            else
              _zmx_rows
            fi
          }

          _zmx_pick() {
            local scoped="''${1:-auto}" output query key selected rc source session_name
            source='_zmx_rows'
            if [[ "$scoped" == scoped || ( "$scoped" == auto && -n "$ZMX_SESSION" ) ]]; then
              source='_zmx_scoped_rows'
            fi

            output=$(eval "$source" | fzf \
              --print-query \
              --expect=ctrl-n \
              --delimiter='\t' \
              --with-nth='1,2,3,4,5' \
              --height=80% \
              --reverse \
              --border-label ' zmx ' \
              --prompt='zmx> ' \
              --header='enter attach  ctrl+n create from query  ctrl+a all' \
              --bind 'ctrl-a:reload(zmx-rows)' \
              --preview='zmx history {1} 2>/dev/null | tail -200' \
              --preview-window='right:60%:follow')
            rc=$?

            query=$(printf '%s\n' "$output" | sed -n '1p')
            key=$(printf '%s\n' "$output" | sed -n '2p')
            selected=$(printf '%s\n' "$output" | sed -n '3p')

            if [[ "$key" == ctrl-n && -n "$query" ]]; then
              session_name=$(_zmx_sanitize "$query")
              [[ -n "$ZMX_SESSION" && "$session_name" != "$ZMX_SESSION".* ]] && session_name="$ZMX_SESSION.$session_name"
            elif [[ $rc -eq 0 && -n "$selected" ]]; then
              session_name=''${selected%%$'\t'*}
            elif [[ -n "$query" ]]; then
              session_name=$(_zmx_sanitize "$query")
              [[ -n "$ZMX_SESSION" && "$session_name" != "$ZMX_SESSION".* ]] && session_name="$ZMX_SESSION.$session_name"
            else
              return 130
            fi

            printf '%s\n' "$session_name"
          }

          zx() {
            local session_name
            if [[ $# -gt 0 ]]; then
              if [[ -n "$ZMX_SESSION" ]]; then
                session_name=$(_zmx_child_name "$1")
              else
                session_name=$(_zmx_sanitize "$1")
              fi
            elif [[ -n "$ZMX_SESSION" ]]; then
              session_name=$(_zmx_pick scoped) || return $?
            else
              session_name=$(_zmx_root)
            fi

            # construct full names here. inheriting zmx's global prefix would make
            # nested names depend on ambient shell state.
            ZMX_SESSION_PREFIX= zmx attach "$session_name"
          }

          zxs() {
            local session_name
            session_name=$(_zmx_pick auto) || return $?
            ZMX_SESSION_PREFIX= zmx attach "$session_name"
          }

          zxl() {
            _zmx_rows | awk -F '\t' '{ printf "%-32s  %-10s  %-12s  %-24s  %s\n", $1, $2, $3, $4, $5 }'
          }

          zxh() {
            local session_name="''${1:-$ZMX_SESSION}"
            [[ -n "$session_name" ]] || { echo 'zxh: missing session name' >&2; return 2; }
            zmx history "$session_name"
          }

          zxt() {
            local session_name="''${1:-$ZMX_SESSION}"
            [[ -n "$session_name" ]] || { echo 'zxt: missing session name' >&2; return 2; }
            zmx tail "$session_name"
          }

          # gc is intentionally confirm-only. detached sessions often contain
          # useful scrollback, so deletion needs an explicit typed confirmation.
          zgc() {
            local selected names ans
            selected=$(_zmx_rows | awk -F '\t' '$2 == "clients:0"' | fzf \
              --multi \
              --delimiter='\t' \
              --with-nth='1,2,3,4,5' \
              --height=80% \
              --reverse \
              --border-label ' zmx gc ' \
              --prompt='zgc> ' \
              --header='tab select detached sessions; enter confirm list' \
              --preview='zmx history {1} 2>/dev/null | tail -200' \
              --preview-window='right:60%:follow') || return $?
            names=$(printf '%s\n' "$selected" | awk -F '\t' 'NF { print $1 }')
            [[ -n "$names" ]] || return 0
            printf 'kill these zmx sessions?\n%s\n' "$names"
            read 'ans?type yes to kill: '
            [[ "$ans" == yes ]] || return 1
            printf '%s\n' "$names" | while IFS= read -r name; do
              zmx kill --force "$name"
            done
          }

          _zmx_connect() {
            zxs
            zle reset-prompt
          }
          zle -N _zmx_connect
          bindkey '^s' _zmx_connect
        '';
      };
  };
in
{
  inherit overlay module;
}
