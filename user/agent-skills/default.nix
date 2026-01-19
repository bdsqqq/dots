{ lib, inputs, hostSystem ? null, config ? {}, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
    
  # YAML frontmatter validator for agent skills
  # warns on invalid frontmatter but never fails the build
  skillsDir = ./skills;
  skillDirs = builtins.attrNames (lib.filterAttrs (_: type: type == "directory") 
    (builtins.readDir skillsDir));
  
  # extract frontmatter from SKILL.md content (between first two ---)
  extractFrontmatter = content:
    let
      lines = lib.splitString "\n" content;
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
  
  validateLine = line:
    let
      trimmed = lib.trim line;
    in
      if trimmed == "" then null
      else if !(lib.hasInfix ":" trimmed) then "missing colon"
      else 
        let
          parts = lib.splitString ":" trimmed;
          rest = lib.concatStringsSep ":" (builtins.tail parts);
          value = lib.trim rest;
        in
          if lib.hasInfix ":" value && !(lib.hasPrefix "\"" value || lib.hasPrefix "'" value)
          then "unquoted colon in value - wrap in quotes"
          else null;
  
  validateFrontmatter = lines:
    builtins.filter (x: x != null) (builtins.map validateLine lines);
  
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
  
  skillWarnings = builtins.filter (x: x != null) (builtins.map validateSkill skillDirs);
  
  warningScript = if skillWarnings == [] then "" else ''
    echo ""
    echo "━━━ AGENT SKILL FRONTMATTER WARNINGS ━━━"
    ${lib.concatMapStringsSep "\n" (w: ''echo "  ${w}"'') skillWarnings}
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
  '';
in
{
  
  home-manager.users.bdsqqq = { pkgs, config, lib, ... }: {
    home.activation.validateAgentSkills = lib.hm.dag.entryBefore [ "writeBoundary" ] warningScript;
    
    # skills at ~/.config/agents/skills (general location for all agents)
    home.file.".config/agents/skills" = {
      source = ./skills;
      recursive = true;
    };
    
    # external git-based skills
    home.file.".config/agents/skills/axiom-sre" = {
      source = inputs.axiom-sre;
      recursive = true;
    };
    
    home.file.".config/agents/skills/lnr/SKILL.md" = {
      source = "${inputs.lnr}/SKILL.md";
    };

    home.file.".config/agents/skills/compound-engineering".source = "${inputs.snarktank-skills}/compound-engineering";
    home.file.".config/agents/skills/frontend-design".source = "${inputs.snarktank-skills}/frontend-design";
    home.file.".config/agents/skills/prd".source = "${inputs.snarktank-skills}/prd";
    home.file.".config/agents/skills/ralph".source = "${inputs.snarktank-skills}/ralph";

    home.file.".config/agents/skills/react-best-practices".source = "${inputs.vercel-skills}/skills/react-best-practices";
    home.file.".config/agents/skills/web-design-guidelines".source = "${inputs.vercel-skills}/skills/web-design-guidelines";
    
    # symlink for amp compatibility: ~/.config/amp/skills → ~/.config/agents/skills
    home.file.".config/amp/skills".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.config/agents/skills";
  };
}
