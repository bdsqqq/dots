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
  ghCredentialWrapper = pkgs: pkgs.writeShellScript "gh-with-api-key" ''
    if [ -z "''${GH_TOKEN:-}" ] && [ -r /run/secrets/gh_token ]; then
      export GH_TOKEN="$(</run/secrets/gh_token)"
    fi
    exec ${pkgs.gh}/bin/gh "$@"
  '';
in
{
  imports = [ ../github/credential.nix ];
  my.github.credential.required = true;

  home-manager.users.bdsqqq = { config, pkgs, ... }: {
    imports = [ inputs.hunk.homeManagerModules.default ];

    custom.path.segments = [
      {
        order = 70;
        value = "${config.home.homeDirectory}/.local/lib/github-auth/bin";
      }
    ];

    home.file.".local/lib/github-auth/bin/gh".source = ghCredentialWrapper pkgs;

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
        credential."https://github.com" = {
          helper = "!${ghCredentialWrapper pkgs} auth git-credential";
          username = "x-access-token";
        };
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
  };
}
