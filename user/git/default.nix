{ inputs, ... }:
let
  git-hunks = { pkgs }:
    pkgs.stdenv.mkDerivation {
      pname = "git-hunks";
      version = "0.1.0";
      src = pkgs.fetchFromGitHub {
        owner = "rockorager";
        repo = "git-hunks";
        rev = "810609b492daae31fd974c220d77c76780db4b11";
        hash = "sha256-VRscBmZ0Q/vL4B+8mkmQGV4Ppoj1qPpDz0kPAACjV94=";
      };
      nativeBuildInputs = [ pkgs.installShellFiles ];
      dontBuild = true;
      installPhase = ''
        runHook preInstall
        install -Dm755 git-hunks $out/bin/git-hunks
        installManPage git-hunks.1
        runHook postInstall
      '';
    };
  amp-skills-hooks = { pkgs }:
    pkgs.writeShellScriptBin "pre-push" ''
      set -euo pipefail

      remote_name="$1"
      if [[ "$remote_name" == "amp-skills" ]]; then
        exit 0
      fi

      main_sha=""
      remote_main_sha=""
      while read -r _local_ref local_sha remote_ref remote_sha; do
        if [[ "$remote_ref" == "refs/heads/main" && ! "$local_sha" =~ ^0+$ ]]; then
          main_sha="$local_sha"
          remote_main_sha="$remote_sha"
        fi
      done

      if [[ -z "$main_sha" ]]; then
        exit 0
      fi

      root="$(${pkgs.git}/bin/git rev-parse --show-toplevel)"
      if [[ ! -d "$root/user/agents/skills" ]]; then
        exit 0
      fi

      amp_remote="$(${pkgs.git}/bin/git -C "$root" remote get-url amp-skills 2>/dev/null || true)"
      if [[ "$amp_remote" != "https://ampcode.com/git/@user_01KTSZFRFVGGBPHVEF4Y6JYCH7/-/skills" ]]; then
        exit 0
      fi

      if [[ ! "$remote_main_sha" =~ ^0+$ ]] &&
        ! ${pkgs.git}/bin/git -C "$root" merge-base --is-ancestor \
          "$remote_main_sha" "$main_sha"; then
        echo "error: refusing to publish agent skills before a non-fast-forward main push" >&2
        echo "fetch and rebase the outer repository, then push again" >&2
        exit 1
      fi

      amp_bin="$(command -v amp || true)"
      if [[ -z "$amp_bin" ]]; then
        echo "error: cannot publish agent skills: amp is not in PATH" >&2
        exit 1
      fi

      ${pkgs.git}/bin/git -C "$root" \
        -c credential.helper= \
        -c "credential.helper=!$amp_bin git-credential-helper" \
        fetch --quiet amp-skills main
      published_sha="$(${pkgs.git}/bin/git -C "$root" rev-parse FETCH_HEAD)"

      echo "Publishing user/agents/skills to Amp User Skills..." >&2
      split_sha="$(${pkgs.git}/bin/git -C "$root" subtree split \
        --prefix=user/agents/skills "$main_sha")"

      published_tree="$(${pkgs.git}/bin/git -C "$root" rev-parse "$published_sha^{tree}")"
      split_tree="$(${pkgs.git}/bin/git -C "$root" rev-parse "$split_sha^{tree}")"
      if [[ "$published_tree" == "$split_tree" ]]; then
        echo "Amp User Skills is already up to date." >&2
        exit 0
      fi

      projection_sha="$split_sha"
      if ! ${pkgs.git}/bin/git -C "$root" merge-base --is-ancestor \
        "$published_sha" "$split_sha"; then
        projection_sha="$(printf '%s\n' "Project user/agents/skills from dots" | \
          ${pkgs.git}/bin/git -C "$root" commit-tree "$split_tree" \
            -p "$published_sha" -p "$split_sha")"
      fi

      ${pkgs.git}/bin/git -C "$root" \
        -c credential.helper= \
        -c "credential.helper=!$amp_bin git-credential-helper" \
        push amp-skills "$projection_sha:refs/heads/main"
    '';
in
{
  home-manager.users.bdsqqq = { pkgs, lib, ... }: {
    imports = [ inputs.hunk.homeManagerModules.default ];

    programs.git = {
      enable = true;

      lfs.enable = true;

      settings = {
        user = {
          name = "Igor Bedesqui";
          email = "igorbedesqui@gmail.com";
        };

        init.defaultBranch = "main";

        pull.rebase = true;
        rebase.autoStash = true;

        core.excludesFile = "~/.gitignore_global";
        core.hooksPath = "~/.config/git/hooks";
        interactive.diffFilter = "${pkgs.delta}/bin/delta --color-only";
        delta = {
          navigate = true;
          side-by-side = true;
        };
        merge.conflictstyle = "diff3";
        diff.colorMoved = "default";

        commit.gpgsign = true;
        tag.gpgsign = true;
        gpg.format = "ssh";
        user.signingKey = "~/.ssh/id_ed25519.pub";
      };
    };

    programs.hunk = {
      enable = true;
      enableGitIntegration = true;
      package = inputs.hunk.packages.${pkgs.stdenv.hostPlatform.system}.default;
    };

    home.packages = with pkgs; [
      lazygit
      delta
      gh
      git-filter-repo
      jq
      (git-hunks { inherit pkgs; })
    ];

    home.shellAliases = {
      g = "lazygit";
    };

    home.file.".config/git/hooks/pre-push".source =
      "${(amp-skills-hooks { inherit pkgs; })}/bin/pre-push";

    home.activation.configureAmpSkillsProjection =
      lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        dots_repo="$HOME/commonplace/01_files/nix"
        if ${pkgs.git}/bin/git -C "$dots_repo" rev-parse --git-dir >/dev/null 2>&1; then
          if ${pkgs.git}/bin/git -C "$dots_repo" remote get-url amp-skills >/dev/null 2>&1; then
            ${pkgs.git}/bin/git -C "$dots_repo" remote set-url amp-skills \
              "https://ampcode.com/git/@user_01KTSZFRFVGGBPHVEF4Y6JYCH7/-/skills"
          else
            ${pkgs.git}/bin/git -C "$dots_repo" remote add amp-skills \
              "https://ampcode.com/git/@user_01KTSZFRFVGGBPHVEF4Y6JYCH7/-/skills"
          fi
        fi
      '';
  };
}
