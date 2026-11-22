{ config
, hostSystem
, lib
, pkgs
, ...
}:
let
  isLinux = lib.hasSuffix "-linux" hostSystem;
  nativeService = config.my.t3Code.nativeService.enable;
  toolsDir = "${config.my.paths.commonplace}/01_files/nix/modules/node-pnpm";
  toolsBin = "${toolsDir}/node_modules/.bin";
  t3Serve = pkgs.writeShellScript "t3-code-serve" ''
    set -eu

    if [ -n "''${CREDENTIALS_DIRECTORY:-}" ]; then
      export GH_TOKEN="$(<"$CREDENTIALS_DIRECTORY/gh_token")"
      export HF_TOKEN="$(<"$CREDENTIALS_DIRECTORY/hf_token")"
      export PARALLEL_API_KEY="$(<"$CREDENTIALS_DIRECTORY/parallel_api_key")"
      export artificial_analysis_api_key="$(<"$CREDENTIALS_DIRECTORY/artificial_analysis_api_key")"
    else
      export GH_TOKEN="$(<${lib.escapeShellArg config.sops.secrets.gh_token.path})"
      export HF_TOKEN="$(<${lib.escapeShellArg config.sops.secrets.hf_token.path})"
      export PARALLEL_API_KEY="$(<${lib.escapeShellArg config.sops.secrets.parallel_api_key.path})"
      export artificial_analysis_api_key="$(<${lib.escapeShellArg config.sops.secrets.artificial_analysis_api_key.path})"
    fi

    exec ${toolsBin}/t3 serve \
      --host 127.0.0.1 \
      --port 3773 \
      --no-browser
  '';
in
{
  options.my.t3Code.nativeService.enable =
    lib.mkEnableOption "T3-owned user service and runtime updates (Linux)";

  imports = [
    ../artificial-analysis/credential.nix
    ../github/credential.nix
    ../huggingface/credential.nix
    ../pi/packages/extensions/web-search/credential.nix
  ];

  config = lib.mkMerge [
    {
      my.artificialAnalysis.credential.required = true;
      my.github.credential.required = true;
      my.huggingface.credential.required = true;
      my.parallelWebSearch.credential.required = true;
    }
    (
      if isLinux then
        {
          # The native launcher selects updated runtimes. Do not put a second,
          # version-pinned server on its port or replace its writable unit.
          users.users.bdsqqq.linger = lib.mkIf nativeService true;
          sops.templates.t3-code-environment = lib.mkIf nativeService {
            owner = "bdsqqq";
            mode = "0400";
            content = ''
              GH_TOKEN="${config.sops.placeholder.gh_token}"
              HF_TOKEN="${config.sops.placeholder.hf_token}"
              PARALLEL_API_KEY="${config.sops.placeholder.parallel_api_key}"
              artificial_analysis_api_key="${config.sops.placeholder.artificial_analysis_api_key}"
            '';
          };
          home-manager.users.bdsqqq.home.file =
            lib.mkIf nativeService {
              ".config/systemd/user/t3code.service.d/nix.conf".text = ''
                [Service]
                Environment=T3CODE_HOST=127.0.0.1
                Environment=T3CODE_PORT=3773
                Environment="PATH=${config.users.users.bdsqqq.home}/.local/bin:${toolsBin}:${config.home-manager.users.bdsqqq.home.profileDirectory}/bin:${lib.makeBinPath [
                  pkgs.cloudflared
                  pkgs.coreutils
                  pkgs.git
                  pkgs.gnused
                  pkgs.nodejs_latest
                ]}"
                EnvironmentFile=${config.sops.templates.t3-code-environment.path}
              '';
            };

          systemd.services.t3-code = lib.mkIf (!nativeService) {
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

            # Installed native tool wrappers must also be visible to the daemon,
            # not only to interactive login shells.
            environment.PATH = lib.mkForce "${config.users.users.bdsqqq.home}/.local/bin:${toolsBin}:${config.home-manager.users.bdsqqq.home.profileDirectory}/bin:${lib.makeBinPath [
              pkgs.cloudflared
              pkgs.coreutils
              pkgs.git
              pkgs.gnused
              pkgs.nodejs_latest
            ]}";
            serviceConfig = {
              Type = "exec";
              User = "bdsqqq";
              Group = "users";
              WorkingDirectory = "/home/bdsqqq";
              LoadCredential = [
                "artificial_analysis_api_key:${config.sops.secrets.artificial_analysis_api_key.path}"
                "gh_token:${config.sops.secrets.gh_token.path}"
                "hf_token:${config.sops.secrets.hf_token.path}"
                "parallel_api_key:${config.sops.secrets.parallel_api_key.path}"
              ];
              ExecStart = t3Serve;
              Restart = "always";
              RestartSec = "5s";
            };
          };
        }
      else
        { }
    )
  ];
}
