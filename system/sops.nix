{ lib, inputs, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  
  sshKeyPath = if isDarwin 
    then "/Users/bdsqqq/.ssh/id_ed25519"
    else "/home/bdsqqq/.ssh/id_ed25519";
  
  homeDir = if isDarwin 
    then "/Users/bdsqqq" 
    else "/home/bdsqqq";

  promptsFile = inputs.self + "/user/agents/prompts.json";
  promptCount = 17;
  promptIds = builtins.genList (i: builtins.toString i) promptCount;

  unpackScript = ''
    DEST="${homeDir}/.config/agents/prompts"
    mkdir -p "$DEST"
    find "$DEST" -maxdepth 1 -name '*.md' -delete 2>/dev/null || true
    for i in $(seq 0 ${builtins.toString (promptCount - 1)}); do
      FNAME_FILE="/run/secrets/prompt-''${i}-filename"
      CONTENT_FILE="/run/secrets/prompt-''${i}-content"
      [ -f "$FNAME_FILE" ] && [ -f "$CONTENT_FILE" ] || continue
      FNAME=$(cat "$FNAME_FILE")
      cp "$CONTENT_FILE" "$DEST/$FNAME"
      chown bdsqqq "$DEST/$FNAME"
      chmod 0400 "$DEST/$FNAME"
    done
  '';
in
{
  sops = {
    age.sshKeyPaths = [ sshKeyPath ];
    
    defaultSopsFile = inputs.self + "/secrets.yaml";
    secrets = {
      anthropic_api_key = { owner = "bdsqqq"; };
      tailscale_auth_key = { owner = "bdsqqq"; };
      gh_token = { owner = "bdsqqq"; };
      hf_token = { owner = "bdsqqq"; };
      open_router = { owner = "bdsqqq"; };
      opencode_zen = { owner = "bdsqqq"; };
      motion_plus_token = { owner = "bdsqqq"; };
      AMP_API_KEY = { owner = "bdsqqq"; };
      parallel_api_key = { owner = "bdsqqq"; };
      syncthing_gui_password = { owner = "bdsqqq"; };
      syncthing_gui_password_hash = { owner = "bdsqqq"; };

      "axiom.toml" = {
        sopsFile = inputs.self + "/.axiom.toml";
        format = "binary";
        owner = "bdsqqq";
        mode = "0400";
        path = "${homeDir}/.axiom.toml";
      };
      
      cookies = {
        sopsFile = inputs.self + "/cookies.txt";
        format = "binary";
        owner = "bdsqqq";
        mode = "0400";
      };
    } // (
      let
        mkSecrets = id: [
          { name = "prompt-${id}-filename"; value = { sopsFile = promptsFile; format = "json"; key = "${id}-filename"; owner = "bdsqqq"; mode = "0400"; }; }
          { name = "prompt-${id}-content";  value = { sopsFile = promptsFile; format = "json"; key = "${id}-content";  owner = "bdsqqq"; mode = "0400"; }; }
        ];
      in builtins.listToAttrs (builtins.concatMap mkSecrets promptIds)
    );
  };
} // (if isDarwin then {
  launchd.daemons.sops-unpack-prompts = {
    script = unpackScript;
    serviceConfig = {
      Label = "dev.bdsqqq.sops-unpack-prompts";
      RunAtLoad = true;
      KeepAlive.PathState."/run/secrets/prompt-0-filename" = true;
      StandardOutPath = "/tmp/sops-unpack-prompts.log";
      StandardErrorPath = "/tmp/sops-unpack-prompts-error.log";
    };
  };
} else {
  systemd.services.sops-unpack-prompts = {
    description = "Unpack sops-encrypted prompts to ~/.config/agents/prompts";
    after = [ "sops-install-secrets.service" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = unpackScript;
  };
})
