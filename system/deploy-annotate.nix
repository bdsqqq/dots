# system/deploy-annotate.nix
# automatically creates an axiom annotation after every nix rebuild
# uses restartTriggers pattern so service restarts AFTER activation completes
{ lib, pkgs, config, hostSystem ? null, ... }:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
  
  stateDir = "/var/lib/nix-deploy-annotate";
  
  annotateScript = pkgs.writeShellScript "nix-deploy-annotate" ''
    set -euo pipefail

    AXIOM_TOKEN_PATH="/run/secrets/axiom_token"
    AXIOM_API="https://api.axiom.co/v2/annotations"
    STATE_DIR="${stateDir}"
    STATE_FILE="$STATE_DIR/last-generation"

    mkdir -p "$STATE_DIR"

    if [[ ! -f "$AXIOM_TOKEN_PATH" ]]; then
      echo "nix-deploy-annotate: axiom token not found, skipping"
      exit 0
    fi

    PROFILE_PATH="/nix/var/nix/profiles/system"

    if [[ ! -L "$PROFILE_PATH" ]]; then
      echo "nix-deploy-annotate: system profile not found, skipping"
      exit 0
    fi

    CURRENT_GEN="$(readlink "$PROFILE_PATH" | grep -oE '[0-9]+' | tail -1)"
    
    # skip if we already annotated this generation
    if [[ -f "$STATE_FILE" ]]; then
      LAST_GEN="$(cat "$STATE_FILE")"
      if [[ "$CURRENT_GEN" == "$LAST_GEN" ]]; then
        echo "nix-deploy-annotate: gen $CURRENT_GEN already annotated, skipping"
        exit 0
      fi
    fi

    AXIOM_TOKEN="$(cat "$AXIOM_TOKEN_PATH")"
    HOSTNAME="$(hostname -s)"
    TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    STORE_PATH="$(readlink -f "$PROFILE_PATH")"
    
    # get git revision from system configuration
    GIT_REV=""
    if [[ -f "/run/current-system/darwin-version.json" ]]; then
      # darwin: read from darwin-version.json
      GIT_REV="$(jq -r '.configurationRevision // empty' /run/current-system/darwin-version.json)"
    elif [[ -x "/run/current-system/sw/bin/nixos-version" ]]; then
      # nixos: use nixos-version from the NEW system (after switch)
      GIT_REV="$(/run/current-system/sw/bin/nixos-version --configuration-revision 2>/dev/null)" || true
    fi
    # strip -dirty suffix for clean commit hash
    GIT_REV="''${GIT_REV%-dirty}"
    GIT_REV_SHORT="''${GIT_REV:0:7}"

    echo "nix-deploy-annotate: creating annotation for $HOSTNAME gen $CURRENT_GEN ($GIT_REV_SHORT)..."

    PAYLOAD=$(cat <<EOF
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

    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$AXIOM_API" \
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
  
  # darwin: use launchd with RunAtLoad - gets reloaded on every switch
  # because the plist changes when the script store path changes
  launchd.daemons.nix-deploy-annotate = {
    script = ''
      # wait for sops secrets
      for i in $(seq 1 30); do
        [ -f /run/secrets/axiom_token ] && break
        sleep 1
      done
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
  
  # use restartTriggers so service restarts AFTER activation completes
  # at that point /run/current-system points to the NEW system
  systemd.services.nix-deploy-annotate = {
    description = "Create Axiom annotation after NixOS rebuild";
    wantedBy = [ "multi-user.target" ];
    
    # restart when config revision changes (i.e., on every new commit)
    # note: can't use config.system.build.toplevel as it causes infinite recursion
    restartTriggers = [ config.system.configurationRevision ];
    
    # ensure secrets and network are available
    after = [ "network-online.target" "sops-nix.service" ];
    wants = [ "network-online.target" ];
    
    # PATH for the script
    path = with pkgs; [ coreutils gnugrep curl jq nettools ];
    
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = annotateScript;
      
      # state directory for generation tracking
      StateDirectory = "nix-deploy-annotate";
    };
  };
  
} else { }
