# Phase 4 Implementation Plan: CLI Tools Migration & Strategic Application Evaluation

Foundation, development migration, and configuration consolidation are complete. This document outlines **Phase 4 priorities** based on the updated 2025 roadmap status.

## Current Status (Updated June 2025)
- ✅ **Foundation Infrastructure**: Complete modular structure with modern flake patterns and unstable overlay
- ✅ **Development Environment**: 100% nix-managed go/node/python toolchains, development tools migrated
- ✅ **System Configuration**: macOS defaults comprehensive setup verified working
- ✅ **Configuration Consolidation**: Karabiner via git submodule + nix module, only vesper theme symlink remains
- ✅ **Networking Configuration**: Fixed SCPreferencesSetLocalHostName() error with proper hostname setup
- ✅ **Tailscale Integration**: Migrated to nix-managed via home-manager for cross-platform availability
- ⏳ **Homebrew Dependency**: 234 packages total (46 casks + 188 formulae), 70% reduction achieved
- 🎯 **CLI Tools Migration**: Ready to start - git ecosystem, media tools, system utilities

## Decision: Phase 4 Focus Areas

**Current Strategy:** CLI tools migration + strategic application evaluation

**Rationale:**
- Configuration consolidation completed successfully (karabiner via submodule + nix)
- 234 homebrew packages remain - realistic 20-30% additional reduction possible
- CLI tools offer highest migration success rate and workflow improvement
- Strategic application evaluation needed for complex Mac-specific applications

## Phase 4A: CLI Tools Migration (High Priority)

*Estimated effort: 2-3 days | Complexity: Low-Medium*  
**IMMEDIATE PRIORITY**

Migrate remaining CLI tools from homebrew to nix where beneficial for better version control and reproducibility.

### Implementation Tasks

1. **Git ecosystem migration**
   ```bash
   # Migrate git-lfs, git-flow, git-extras to nix versions
   # Consolidate git tooling for consistent behavior
   # Test git workflow compatibility
   ```

2. **Media processing tools**
   ```bash
   # Migrate remaining imagemagick/ffmpeg variants to nix
   # Consolidate media processing toolchain
   # Test codec compatibility and performance
   ```

3. **System utilities migration**
   ```bash
   # Migrate remaining system tools (archiving, compression, etc.)
   # Replace macOS-specific tools with cross-platform nix alternatives where beneficial
   # Test functionality and performance
   ```

4. **Python/Ruby ecosystem evaluation**
   ```bash
   # Evaluate python@3.12, ruby dependencies for nix migration
   # Test compatibility with existing workflows
   # Document strategic decisions for complex language environments
   ```

### Success Criteria
- 20-30% additional homebrew reduction through CLI tool migration
- Consolidated and consistent CLI toolchain via nix
- Maintained or improved daily workflow experience
- Documented rationale for remaining homebrew dependencies

## Phase 4B: Strategic Application Evaluation (Medium Priority)

*Estimated effort: 2-3 days | Complexity: Medium-High*  
**FOLLOW-UP TO 4A**

Evaluate complex applications and services for potential nix migration or strategic homebrew retention.

### Implementation Tasks

1. **Editor ecosystem evaluation**
   ```bash
   # Evaluate vscode extensions via nix vs keep cursor as cask
   # Test declarative extension management viability
   # Document workflow impact of different approaches
   ```

2. **Terminal stack evaluation**
   ```bash
   # Analyze warp vs alacritty/kitty + tmux for full nix control
   # Test terminal performance and feature parity
   # Implement nix-managed terminal configuration if beneficial
   ```

3. **Container runtime evaluation**
   ```bash
   # Test colima + podman vs docker desktop
   # Evaluate nix-managed container runtime viability
   # Test docker-compose workflow compatibility
   ```

### Success Criteria
- Strategic decisions documented for complex applications
- Workflow impact assessed for major application changes
- Clear rationale for nix vs homebrew retention decisions

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

### Week 5-6: CLI Tools Migration & Strategic Application Evaluation (Current)
- Migrate CLI tools (git ecosystem, media processing, system utilities) to nix
- Strategic evaluation of complex applications for nix migration viability
- Consolidate overlapping homebrew packages and eliminate redundancies
- Document rationale for remaining homebrew dependencies

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

### Phase 4A & 4B: CLI Tools Migration & Application Evaluation
```bash
darwin-rebuild switch --flake . --show-trace
# Test CLI tool migrations for functionality and performance
# Validate complex applications before major changes
```

### Testing & Validation
```bash
# Test development environments still work
go version && node --version && python --version
# Validate CLI tools migrated successfully
git --version && convert --version && ffmpeg -version
# Check homebrew package count reduction
brew list | wc -l
```

## Risk Mitigation

**Phase 4A**: Low risk - CLI tool migrations with predictable behavior, easy rollback  
**Phase 4B**: Medium risk - complex application changes may affect workflow, test extensively  
**Testing Strategy**: CLI tools first for quick wins, application evaluation with parallel testing

## Success Metrics

- **CLI Tools Migration**: 20-30% additional homebrew reduction through systematic tool migration
- **Application Evaluation**: Strategic decisions documented for complex applications with clear rationale
- **Overall Phase 4**: Realistic homebrew reduction while maintaining optimal daily workflow experience
