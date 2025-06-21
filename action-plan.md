# Implementation Plan: Foundation → Development Migration

Modular structure migration is complete. This document outlines our **chosen implementation path** from the 2025 roadmap Phase 1.

## Current Status
- ✅ **Modular Structure**: Complete migration from flat to modular nix-darwin structure
- ✅ **Directory Organization**: Proper separation of concerns across modules/
- ✅ **Neovim Configuration**: Excellent nixvim setup with LSP and AI assistance
- 🔄 **Foundation Incomplete**: Missing modern flake patterns and overlays
- ❌ **Secrets Management**: Basic sops-nix setup but not actively used
- ❌ **Development Tools**: Still dependent on 70+ homebrew packages

## Decision: Foundation-First Approach

**Chosen Path:** Option A → Option C → Option B (later)

**Rationale:**
- Foundation infrastructure provides cleanest base for subsequent migrations
- Better package availability via unstable overlay enables smoother dev tool migration  
- Secrets management is functional enough to defer while focusing on workflow improvements
- Lower risk progression from organizational improvements to complex toolchain migration

## Phase 1: Complete Foundation Infrastructure

*Estimated effort: 2-3 days | Complexity: Medium*  
**IMMEDIATE PRIORITY**

Finalize the foundational flake architecture with modern 2025 patterns.

### Implementation Tasks

1. **Implement flake-parts organization**
   ```bash
   # Add flake-parts input to flake.nix
   # Refactor flake.nix to use flake-parts.lib.mkFlake
   # Create flake-modules/ directory for reusable components
   ```

2. **Setup nixpkgs-unstable overlay**
   ```bash
   # Add nixpkgs-unstable input
   # Create overlays/unstable.nix for bleeding-edge packages
   # Configure overlay in flake.nix
   ```

3. **Enhance specialArgs and input handling**
   ```bash
   # Pass all inputs to modules via specialArgs
   # Add system detection and multi-architecture support
   # Setup proper input follows for dependency management
   ```

### Success Criteria
- Clean flake-parts based organization
- Access to latest packages via unstable overlay
- Multi-system support ready for future machines
- Sub-30s rebuild times maintained

## Phase 2: Development Environment Migration

*Estimated effort: 4-5 days | Complexity: Medium-High*  
**STARTS AFTER PHASE 1 COMPLETION**

Migrate critical development tools from homebrew to nix management.

### Implementation Tasks

1. **Go toolchain migration**
   ```bash
   # Replace homebrew go@1.20, go@1.21 with nix versions
   # Setup go version management via overlays
   # Migrate GOPATH and module configuration
   ```

2. **Node ecosystem replacement**
   ```bash
   # Replace homebrew node versions with nix-managed
   # Implement corepack for package manager control
   # Setup project-specific node versions via direnv
   ```

3. **Python environment consolidation**
   ```bash
   # Consolidate python@3.9-3.13 to nix-managed versions
   # Setup proper venv integration with nix
   # Migrate poetry/pip configurations
   ```

### Success Criteria
- 50%+ reduction in homebrew dependencies
- Declarative version management for all languages
- Project-specific environment isolation
- Faster development environment setup

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

**Phase 1 → Phase 2 → Future Phases**

### Week 1-2: Foundation Infrastructure
- Complete flake-parts refactoring and unstable overlay
- Enhanced input handling and multi-system support
- Validate foundation before proceeding

### Week 3-4: Development Environment Migration  
- Begin development tool migration with solid foundation in place
- Go, Node, Python toolchain transitions
- Validate workflow improvements

### Future: Secrets & Advanced Features
- Secrets management when workflow is stable
- Application ecosystem migration (vscode, docker, terminal)
- macOS system defaults and comprehensive configuration
- Advanced automation and cross-machine compatibility

## Execution Commands

### Phase 1: Foundation
```bash
darwin-rebuild switch --flake . --show-trace
# Validate with: nix flake check
```

### Phase 2: Development Migration
```bash
darwin-rebuild switch --flake . --show-trace  
# Test development environments after each migration
```

## Risk Mitigation

**Phase 1**: Low risk - organizational improvements with rollback capability  
**Phase 2**: Medium risk - staged migration with testing between language toolchains  
**Future Phases**: Deferred until core workflow is stable

## Success Metrics

- **Foundation Complete**: Sub-30s rebuilds + unstable overlay access
- **Development Migration**: 50% homebrew reduction + isolated environments  
- **Overall**: Faster dev setup + declarative reproducibility
