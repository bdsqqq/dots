---
type:
- type/documentation
area: nix-configuration
keywords:
- claude-code
- agent-guides
- nix-darwin
- home-manager
status:
- status/complete
created: 2025-06-26
author:
- opencode
permalink: 01-files/nix/agent-guides-integration
---

# Agent-Guides Integration with Nix Configuration

This document describes the integration of the [tokenbender/agent-guides](https://github.com/tokenbender/agent-guides) repository with a Nix-Darwin configuration. The integration provides Claude Code custom commands through declarative configuration management, following established Nix and home-manager patterns.

## Implementation Overview

The integration creates a dedicated module (`modules/home-manager/claude.nix`) that manages Claude Code custom commands as Nix-managed home files. This approach ensures reproducible builds through SHA256 verification while maintaining the existing modular configuration structure.

### Core Components

**Dedicated Claude Module**: A new `claude.nix` module handles all Claude-specific configuration, separating concerns from the existing development tools configuration.

**Command Management**: Five custom commands from the agent-guides repository are installed as `/user:` commands:
- `search-prompts`: Searches across Claude Code conversation history
- `analyze-function`: Provides detailed function analysis
- `multi-mind`: Enables multi-specialist collaborative analysis
- `page`: Manages session history with citations
- `crud-claude-commands`: Provides dynamic command management

**Supporting Tools**: The integration includes a Python extraction script and an update utility for maintaining current command versions.

## File Structure

The implementation follows the existing modular pattern:

```
modules/home-manager/
├── claude.nix          # New: Claude-specific configuration
├── default.nix         # Modified: Added claude.nix import
├── development.nix     # Existing: Contains claude-code package
└── ...

~/.claude/commands/     # Commands installed here
├── search-prompts.md
├── analyze-function.md
├── multi-mind.md
├── page.md
└── crud-claude-commands.md
```

## Configuration Application

To apply the new configuration:

```bash
# Build and switch to new configuration
sudo darwin-rebuild switch --flake ~/commonplace/01_files/nix

# Or build without switching for testing
darwin-rebuild build --flake ~/commonplace/01_files/nix
```

## Command Usage

Commands become available immediately after configuration application:

```bash
# Search conversation history
/user:search-prompts "machine learning pipeline"

# Analyze code functions
/user:analyze-function train.py:detect_words_gpu

# Multi-specialist analysis
/user:multi-mind "Should we implement quantum error correction?"

# Session management
/user:page feature-implementation

# Command management
/user:crud-claude-commands list
```

## Maintenance Procedures

### Updating Command Versions

When the agent-guides repository updates, command hashes require updating:

```bash
# Get new hash for a command
nix-prefetch-url https://raw.githubusercontent.com/tokenbender/agent-guides/main/claude-commands/search-prompts.md

# Update the hash in claude.nix, then rebuild
sudo darwin-rebuild switch --flake ~/commonplace/01_files/nix
```

### Adding New Commands

1. Add the command to the `claudeCommands` attribute set in `claude.nix`
2. Obtain the SHA256 hash using `nix-prefetch-url`
3. Rebuild the configuration

## Design Principles Applied

The implementation follows established Nix best practices:

**Modular Architecture**: Claude configuration is isolated in a dedicated module, maintaining separation of concerns.

**Declarative Management**: All files are managed through Nix expressions rather than imperative scripts.

**Reproducible Builds**: SHA256 hashes ensure identical builds across different machines and times.

**Immutable Configuration**: Files are read-only and managed entirely by Nix, preventing drift.

**Integration Consistency**: The module integrates with existing shell configuration and package management patterns.

## Integration Points

The implementation preserves existing configuration:

- **claude-code package**: Remains defined in `development.nix:102`
- **API key management**: Continues using sops for `ANTHROPIC_API_KEY`
- **Dependencies**: Leverages existing Python and Git installations
- **Shell integration**: Adds aliases to the existing zsh configuration

## Troubleshooting

**Commands not available**: Verify the configuration has been rebuilt and files exist in `~/.claude/commands/`

**Permission errors**: Files should be read-only and owned by the user account

**Hash verification failures**: Update hashes when the agent-guides repository changes

**Script execution issues**: Ensure Python 3 is available through `home.packages`

## Future Considerations

The modular design supports extension through additional command sources or custom commands. The update mechanism can be enhanced to automatically detect and update hashes when upstream changes occur.

The configuration provides a foundation for managing Claude Code workflows declaratively while maintaining the flexibility to add project-specific commands through the existing `.claude/commands/` directory structure.