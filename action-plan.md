# Phase 4 Implementation Plan: Application Ecosystem & Configuration Consolidation

Foundation and development migration are complete. This document outlines **Phase 4 priorities** based on the updated 2025 roadmap status.

## Current Status (Updated June 2025)
- ✅ **Foundation Infrastructure**: Complete modular structure with modern flake patterns and unstable overlay
- ✅ **Development Environment**: 100% nix-managed go/node/python toolchains, 95% homebrew reduction
- ✅ **System Configuration**: macOS defaults comprehensive setup verified working
- ✅ **CLI Modernization**: All development and system tools migrated to nix
- 🔄 **Configuration Consolidation**: Karabiner config still symlinked, dotfiles need consolidation
- 🔄 **Application Migration**: ~5 remaining homebrew casks need evaluation

## Decision: Phase 4 Focus Areas

**Current Strategy:** Application ecosystem migration + configuration consolidation

**Rationale:**
- Foundation and development environments are complete and stable
- Configuration symlinks are the last manual intervention points
- Remaining homebrew applications need strategic evaluation for nix alternatives
- High impact improvements for daily workflow and system reproducibility

## Phase 4A: Application Ecosystem Migration (High Priority)

*Estimated effort: 3-4 days | Complexity: Medium*  
**IMMEDIATE PRIORITY**

Evaluate and migrate remaining homebrew applications to nix alternatives where beneficial.

### Implementation Tasks

1. **Terminal stack evaluation**
   ```bash
   # Analyze warp vs alacritty/kitty + tmux
   # Test terminal performance and feature compatibility
   # Implement nix-managed terminal configuration if beneficial
   ```

2. **Editor ecosystem**
   ```bash
   # Evaluate vscode extensions via nix vs keep as cask
   # Test cursor vs vscode for AI development workflow
   # Implement declarative extension management if viable
   ```

3. **Docker alternatives**
   ```bash
   # Test colima + podman vs docker desktop
   # Implement nix-managed container runtime
   # Migrate docker-compose workflows to new setup
   ```

4. **Remaining homebrew analysis**
   ```bash
   # Audit ~5 remaining casks for nix alternatives
   # Document strategic decisions for mac-only applications
   # Clean final homebrew dependencies
   ```

### Success Criteria
- Strategic decisions made for all remaining applications
- 98%+ homebrew reduction where technically feasible
- Maintained or improved daily workflow experience
- Documented rationale for any remaining homebrew dependencies

## Phase 4B: Configuration Consolidation (High Priority)

*Estimated effort: 2-3 days | Complexity: Medium*  
**PARALLEL WITH 4A**

Eliminate all manual configuration symlinks and consolidate into home-manager.

### Implementation Tasks

1. **Karabiner configuration migration**
   ```bash
   # Migrate ~/02_work/_self/karabiner to nix management
   # Test complex-modifications and application-specific rules
   # Implement declarative keyboard customization
   ```

2. **Dotfiles consolidation**
   ```bash
   # Identify remaining manual symlinks in ~/.config/
   # Migrate application configs to home-manager modules
   # Implement proper XDG directory management
   ```

3. **SSH configuration migration**
   ```bash
   # Move ~/.ssh/config to home-manager declarative management
   # Implement proper ssh key organization
   # Setup host-specific ssh configurations
   ```

### Success Criteria
- Zero manual symlinks or configuration files
- All dotfiles managed through home-manager
- SSH configuration fully declarative
- Karabiner complex modifications working via nix

## Future Phase: Secrets Infrastructure Modernization
*Estimated effort: 3-4 days | Complexity: High*

Complete the sops-nix integration with proper age encryption and key management.

### Tasks (Deferred)
1. **Complete sops-nix with age encryption**
   ```bash
   # Generate age key from ssh key: ssh-keyscan | age-keygen -y
   # Create .sops.yaml with age recipients
   # Setup encrypted secrets repository
   ```

2. **Migrate SSH keys to declarative management**
   ```bash
   # Move ~/.ssh/config to modules/home-manager/development/ssh.nix
   # Implement proper ssh key derivation for age
   # Setup host-specific ssh configurations
   ```

3. **Implement secret rotation strategy**
   ```bash
   # Create separate secrets repository
   # Setup automated secret rotation procedures
   # Document emergency recovery procedures
   ```

### Success Criteria
- All secrets encrypted with age and version controlled
- SSH configuration fully declarative
- Zero manual secret management
- Proper backup and recovery procedures

## Implementation Timeline

**Phase 4A + 4B → Future Phases**

### Week 5-6: Application Ecosystem & Configuration Consolidation (Current)
- Evaluate remaining homebrew applications for nix alternatives
- Migrate karabiner configuration to declarative management
- Consolidate all dotfiles and eliminate manual symlinks
- Complete SSH configuration migration to home-manager

### Week 7-8: Services & Advanced Automation (Next)
- System services migration (postgresql, custom launchd services)
- Development infrastructure (redis/memcached local services)
- Font and appearance management via nix
- Performance optimization and binary cache setup

### Future: Cross-Platform & Advanced Features
- Secrets management expansion (when workflow is stable)
- Cross-machine compatibility testing
- Documentation and disaster recovery procedures
- Advanced monitoring and maintenance automation

## Execution Commands

### Phase 4A & 4B: Application & Configuration Migration
```bash
darwin-rebuild switch --flake . --show-trace
# Test application replacements before permanent migration
# Validate karabiner complex-modifications after migration
```

### Testing & Validation
```bash
# Test development environments still work
go version && node --version && python --version
# Validate system defaults still working
defaults read com.apple.dock
# Check configuration symlinks eliminated
find ~/.config -type l -ls
```

## Risk Mitigation

**Phase 4A**: Medium risk - application replacements may affect daily workflow, test extensively  
**Phase 4B**: Low risk - configuration migration with rollback capability via git  
**Testing Strategy**: Parallel testing before permanent migration, maintain rollback procedures

## Success Metrics

- **Application Migration**: 98%+ homebrew reduction while maintaining workflow quality
- **Configuration Consolidation**: Zero manual symlinks, all dotfiles via home-manager
- **Overall Phase 4**: Complete system reproducibility via single `darwin-rebuild` command
