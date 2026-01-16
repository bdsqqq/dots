{ lib, inputs, hostSystem ? null, config ? {}, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  
  # motion+ token from sops for MCP server
  motionPlusTokenPath = "/run/secrets/motion_plus_token";
  
  # YAML frontmatter validator for amp skills
  # warns on invalid frontmatter but never fails the build
  skillsDir = ./skills;
  skillDirs = builtins.attrNames (lib.filterAttrs (_: type: type == "directory") 
    (builtins.readDir skillsDir));
  
  # extract frontmatter from SKILL.md content (between first two ---)
  extractFrontmatter = content:
    let
      lines = lib.splitString "\n" content;
      # find indices of --- lines
      findFM = idx: acc: lines':
        if lines' == [] then acc
        else if builtins.head lines' == "---" then 
          findFM (idx + 1) (acc ++ [idx]) (builtins.tail lines')
        else findFM (idx + 1) acc (builtins.tail lines');
      fmIndices = findFM 0 [] lines;
    in
      if builtins.length fmIndices >= 2 then
        lib.sublist (builtins.elemAt fmIndices 0 + 1) 
                    (builtins.elemAt fmIndices 1 - builtins.elemAt fmIndices 0 - 1) 
                    lines
      else [];
  
  # validate a single frontmatter line (key: value format)
  # returns null if valid, error string if invalid
  validateLine = line:
    let
      trimmed = lib.trim line;
    in
      if trimmed == "" then null
      else if !(lib.hasInfix ":" trimmed) then "missing colon"
      else 
        let
          parts = lib.splitString ":" trimmed;
          key = builtins.head parts;
          # value after first colon (rejoined if multiple colons)
          rest = lib.concatStringsSep ":" (builtins.tail parts);
          value = lib.trim rest;
        in
          # check for unquoted colons in value (common YAML gotcha)
          if lib.hasInfix ":" value && !(lib.hasPrefix "\"" value || lib.hasPrefix "'" value)
          then "unquoted colon in value - wrap in quotes"
          else null;
  
  # validate frontmatter lines, return list of errors
  validateFrontmatter = lines:
    builtins.filter (x: x != null) (builtins.map validateLine lines);
  
  # validate a skill directory, return warning message or null
  validateSkill = name:
    let
      skillFile = skillsDir + "/${name}/SKILL.md";
      content = builtins.readFile skillFile;
      fm = extractFrontmatter content;
      errors = validateFrontmatter fm;
    in
      if fm == [] then "⚠ ${name}: no YAML frontmatter found"
      else if errors != [] then "⚠ ${name}: ${builtins.head errors}"
      else null;
  
  # collect all warnings (filter out nulls)
  skillWarnings = builtins.filter (x: x != null) (builtins.map validateSkill skillDirs);
  
  # format warning message for activation script
  warningScript = if skillWarnings == [] then "" else ''
    echo ""
    echo "━━━ AMP SKILL FRONTMATTER WARNINGS ━━━"
    ${lib.concatMapStringsSep "\n" (w: ''echo "  ${w}"'') skillWarnings}
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
  '';
in
{
  
  home-manager.users.bdsqqq = { pkgs, config, lib, ... }: {
    # emit warnings during activation (runs on darwin-rebuild switch)
    home.activation.validateAmpSkills = lib.hm.dag.entryBefore [ "writeBoundary" ] warningScript;
    
    # link the entire skills directory - structure mirrors target
    home.file.".config/amp/skills" = {
      source = ./skills;
      recursive = true;
    };
    
    # external git-based skills (from flake inputs)
    home.file.".config/amp/skills/axiom-sre" = {
      source = inputs.axiom-sre;
      recursive = true;
    };
    
    # lnr skill - just the SKILL.md from the lnr repo
    home.file.".config/amp/skills/lnr/SKILL.md" = {
      source = "${inputs.lnr}/SKILL.md";
    };

    # shell wrappers for rush mode execution
    home.shellAliases = {
      # ship: commit and push in rush mode, continuing current thread
      ship = "amp --mode rush -x 'use the git-ship skill'";
      
      # wt: create worktree in rush mode  
      wt = "amp --mode rush -x 'use the git-worktree skill'";
    };

    # amp wrapper: private by default, but workspace-scoped in axiom repos
    programs.zsh.initExtra = ''
      amp() {
        if [[ "$PWD" = "$HOME/www/axiom"* ]]; then
          command amp "$@"
        else
          command amp --visibility private "$@"
        fi
      }
    '';
    
    # generate settings.json with motion+ MCP server using sops secret
    # runs after sops secrets are available
    home.activation.generateAmpSettings = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      set -euo pipefail
      
      AMP_CONFIG_DIR="$HOME/.config/amp"
      SETTINGS_FILE="$AMP_CONFIG_DIR/settings.json"
      TOKEN_FILE="${motionPlusTokenPath}"
      
      mkdir -p "$AMP_CONFIG_DIR"
      
      # read token from sops secret if available
      if [ -f "$TOKEN_FILE" ]; then
        MOTION_TOKEN=$(cat "$TOKEN_FILE" | tr -d '[:space:]')
        
        cat > "$SETTINGS_FILE" << EOF
{
  "amp.dangerouslyAllowAll": true,
  "mcpServers": {
    "motion": {
      "command": "npx",
      "args": [
        "-y",
        "https://api.motion.dev/registry.tgz?package=motion-studio-mcp&version=latest&token=$MOTION_TOKEN"
      ]
    }
  }
}
EOF
        echo "amp settings.json generated with motion+ MCP"
      else
        # fallback: basic settings without MCP
        cat > "$SETTINGS_FILE" << EOF
{
  "amp.dangerouslyAllowAll": true
}
EOF
        echo "amp settings.json generated (no motion+ token found at $TOKEN_FILE)"
      fi
    '';
  };
}
