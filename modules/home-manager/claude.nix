{ config, pkgs, lib, ... }:

let
  # Agent-guides repository information
  agentGuidesRepo = "https://github.com/tokenbender/agent-guides";
  agentGuidesCommands = "https://raw.githubusercontent.com/tokenbender/agent-guides/main/claude-commands";
  
  # Claude command files with their hashes
  claudeCommands = {
    "search-prompts.md" = "0z9m00y1acjpz788w5z137dx0vmdyd58qp86xrl6ysky3knd4sqm";
    "analyze-function.md" = "0niyb09ix7cjk8f48vdv09148nfgmq00sg0da6prz27xv6znljh2";
    "multi-mind.md" = "195nkj9i1xqkgpig43d1v9n1a1cx8apx0q0rb2kqyk2is1lsairl";
    "page.md" = "19zwzh4ksaaqc91fh2q2v7h5jd73lrpb8j8wjbsivinwkrs2mpiq";
    "crud-claude-commands.md" = "1349l7sr1n07k8807d7gj71za5klfjrq921qrngc5g9022hq5z89";
  };

  # Create home.file entries for each command
  commandFiles = lib.mapAttrs' (name: hash: 
    lib.nameValuePair ".claude/commands/${name}" {
      source = pkgs.fetchurl {
        url = "${agentGuidesCommands}/${name}";
        sha256 = hash;
      };
    }
  ) claudeCommands;

  # Extract Claude session script
  extractClaudeSession = pkgs.fetchurl {
    url = "https://raw.githubusercontent.com/tokenbender/agent-guides/main/scripts/extract-claude-session.py";
    sha256 = "0wrw0k6q0fym1d9yr2rl3cn71lhcxdfqylbb24ik9lbl2b3jiqjl";
  };

  # Update script for keeping commands current
  updateClaudeCommands = pkgs.writeShellScriptBin "update-claude-commands" ''
    set -euo pipefail
    
    echo "🔄 Updating Claude commands from agent-guides..."
    
    # Create temp directory
    TEMP_DIR=$(mktemp -d)
    trap "rm -rf $TEMP_DIR" EXIT
    
    # Clone latest agent-guides
    ${pkgs.git}/bin/git clone ${agentGuidesRepo} "$TEMP_DIR/agent-guides"
    
    # Copy commands to global Claude directory
    mkdir -p ~/.claude/commands
    cp "$TEMP_DIR/agent-guides/claude-commands"/*.md ~/.claude/commands/
    
    # Copy extraction script
    mkdir -p ~/.local/bin
    cp "$TEMP_DIR/agent-guides/scripts/extract-claude-session.py" ~/.local/bin/
    chmod +x ~/.local/bin/extract-claude-session.py
    
    echo "✅ Claude commands updated successfully!"
    echo ""
    echo "📋 Available commands:"
    ls -1 ~/.claude/commands/*.md | sed 's/.*\///;s/\.md$//' | sed 's/^/  \/user:/'
    echo ""
    echo "💡 To update your Nix configuration with new hashes, run:"
    echo "   nix-prefetch-url <command-url>"
  '';

in {
  # Install Claude commands as home files
  home.file = commandFiles // {
    # Add the extraction script to local bin
    ".local/bin/extract-claude-session.py" = {
      source = extractClaudeSession;
      executable = true;
    };
    
    # Create a CLAUDE.md file with agent-guides information
    "CLAUDE.md" = {
    text = ''
      ---
      type:
        - "type/reference"
      area: "claude-code"
      keywords:
        - "custom-commands"
        - "agent-guides"
        - "workflow"
      status:
        - "status/active"
      created: 2025-06-26
      ---

      # Claude Code Configuration

      This system includes custom commands from the [agent-guides](${agentGuidesRepo}) repository, providing enhanced workflow capabilities for Claude Code sessions.

      ## Available Commands

      ${lib.concatStringsSep "\n" (lib.mapAttrsToList (name: _: "- `/user:${lib.removeSuffix ".md" name}`") claudeCommands)}

      ## Command Descriptions

      **search-prompts**: Searches across Claude Code conversation history using multiple sources and pattern matching techniques.

      **analyze-function**: Provides detailed line-by-line analysis of functions, including performance implications and architectural connections.

      **multi-mind**: Executes multi-specialist collaborative analysis using independent subagents with web search integration.

      **page**: Manages session history with complete citations and prepares for memory compaction.

      **crud-claude-commands**: Provides dynamic command management with create, read, update, and delete operations.

      ## Maintenance

      Commands are managed declaratively through Nix configuration in `modules/home-manager/claude.nix`. Updates require modifying hash values and rebuilding the system configuration.

      To update commands to current versions:
      ```bash
      update-claude-commands
      ```

      ## Configuration Management

      The integration follows Nix best practices with SHA256 verification and immutable file management. Command files are read-only and managed entirely through the Nix configuration system.
    '';
    };
  };

  # Add required packages
  home.packages = with pkgs; [
    # Python for the extraction script
    python3
    
    # Update script for keeping commands current
    updateClaudeCommands
  ];

  # Add shell aliases for convenience
  programs.zsh.shellAliases = {
    claude-update = "update-claude-commands";
    claude-commands = "ls -1 ~/.claude/commands/*.md | sed 's/.*\///;s/\\.md$//' | sed 's/^/  \\/user:/'";
  };
}