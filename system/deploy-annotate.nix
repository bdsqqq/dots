# system/deploy-annotate.nix
# automatically creates an axiom annotation after every nix rebuild
{ lib, pkgs, config, hostSystem ? null, ... }:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
  
  stateDir = if isDarwin then "/var/lib/nix-deploy-annotate" else "/var/lib/nix-deploy-annotate";
  
  annotateScript = pkgs.writeShellScript "nix-deploy-annotate" ''
    set -euo pipefail

    AXIOM_TOKEN_PATH="/run/secrets/axiom_token"
    AXIOM_API="https://api.axiom.co/v2/annotations"
    STATE_DIR="${stateDir}"
    STATE_FILE="$STATE_DIR/last-generation"

    ${pkgs.coreutils}/bin/mkdir -p "$STATE_DIR"

    if [[ ! -f "$AXIOM_TOKEN_PATH" ]]; then
      echo "nix-deploy-annotate: axiom token not found, skipping"
      exit 0
    fi

    PROFILE_PATH="/nix/var/nix/profiles/system"

    if [[ ! -L "$PROFILE_PATH" ]]; then
      echo "nix-deploy-annotate: system profile not found, skipping"
      exit 0
    fi

    CURRENT_GEN="$(${pkgs.coreutils}/bin/readlink "$PROFILE_PATH" | ${pkgs.gnugrep}/bin/grep -oE '[0-9]+' | ${pkgs.coreutils}/bin/tail -1)"
    
    # skip if we already annotated this generation
    if [[ -f "$STATE_FILE" ]]; then
      LAST_GEN="$(${pkgs.coreutils}/bin/cat "$STATE_FILE")"
      if [[ "$CURRENT_GEN" == "$LAST_GEN" ]]; then
        echo "nix-deploy-annotate: gen $CURRENT_GEN already annotated, skipping"
        exit 0
      fi
    fi

    AXIOM_TOKEN="$(${pkgs.coreutils}/bin/cat "$AXIOM_TOKEN_PATH")"
    HOSTNAME="$(${pkgs.nettools}/bin/hostname -s)"
    TIMESTAMP="$(${pkgs.coreutils}/bin/date -u +"%Y-%m-%dT%H:%M:%SZ")"
    STORE_PATH="$(${pkgs.coreutils}/bin/readlink -f "$PROFILE_PATH")"
    
    # get git revision from system configuration
    GIT_REV=""
    if [[ -f "/run/current-system/configuration-revision" ]]; then
      GIT_REV="$(${pkgs.coreutils}/bin/cat /run/current-system/configuration-revision)"
    elif [[ -f "$PROFILE_PATH/configuration-revision" ]]; then
      GIT_REV="$(${pkgs.coreutils}/bin/cat "$PROFILE_PATH/configuration-revision")"
    fi
    GIT_REV_SHORT="''${GIT_REV:0:7}"

    echo "nix-deploy-annotate: creating annotation for $HOSTNAME gen $CURRENT_GEN ($GIT_REV_SHORT)..."

    PAYLOAD=$(${pkgs.coreutils}/bin/cat <<EOF
{
  "time": "$TIMESTAMP",
  "type": "nix-deploy",
  "datasets": ["papertrail", "host-metrics"],
  "title": "$HOSTNAME gen $CURRENT_GEN''${GIT_REV_SHORT:+ ($GIT_REV_SHORT)}",
  "description": "nix generation $CURRENT_GEN deployed to $HOSTNAME\n\ncommit: $GIT_REV\nstore path: $STORE_PATH",
  "url": "https://github.com/bdsqqq/dots/commit/$GIT_REV"
}
EOF
    )

    RESPONSE=$(${pkgs.curl}/bin/curl -s -w "\n%{http_code}" -X POST "$AXIOM_API" \
      -H "Authorization: Bearer $AXIOM_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD" 2>&1) || true

    HTTP_CODE=$(echo "$RESPONSE" | tail -1)

    if [[ "$HTTP_CODE" -ge 200 && "$HTTP_CODE" -lt 300 ]]; then
      echo "$CURRENT_GEN" > "$STATE_FILE"
      echo "nix-deploy-annotate: annotation created for $HOSTNAME gen $CURRENT_GEN"
    else
      echo "nix-deploy-annotate: axiom api returned $HTTP_CODE (non-fatal)"
    fi
  '';
  
  # cli wrapper for manual use
  deployAnnotateCli = pkgs.writeShellScriptBin "nix-deploy-annotate" ''
    exec ${annotateScript}
  '';
in
if isDarwin then {
  environment.systemPackages = [ deployAnnotateCli ];
  
  launchd.daemons.nix-deploy-annotate = {
    script = ''
      exec ${annotateScript}
    '';
    serviceConfig = {
      Label = "dev.bdsqqq.nix-deploy-annotate";
      RunAtLoad = true;
      KeepAlive = false;
      StandardOutPath = "/var/log/nix-deploy-annotate.log";
      StandardErrorPath = "/var/log/nix-deploy-annotate.log";
    };
  };
  
} else if isLinux then {
  environment.systemPackages = [ deployAnnotateCli ];
  
  systemd.services.nix-deploy-annotate = {
    description = "Create Axiom annotation for nix deployment";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" "sops-install-secrets.service" ];
    wants = [ "network-online.target" ];
    
    serviceConfig = {
      Type = "oneshot";
      ExecStart = annotateScript;
      RemainAfterExit = true;
    };
  };
  
} else { }
