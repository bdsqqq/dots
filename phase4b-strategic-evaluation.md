# Phase 4B: Strategic Application Evaluation

## Executive Summary

Current homebrew landscape: 46 casks, 188 formulae (234 total packages)  
**Target**: Strategic decisions on complex applications with clear migration rationale

## Evaluation Framework

### Decision Criteria
- **Workflow Impact**: How disruptive would migration be? (1-5 scale)
- **Feature Parity**: Do nix alternatives match current functionality? (1-5 scale)  
- **Maintenance Burden**: Is nix management better than homebrew? (1-5 scale)
- **Cross-Platform Value**: Would nix versions work across environments? (1-5 scale)

### Risk Assessment
- **Low Risk**: CLI tools, utilities with clear nix equivalents
- **Medium Risk**: Complex applications with configuration dependencies
- **High Risk**: Workflow-critical applications with Mac-specific integrations

## Focus Area Evaluations

### 1. Editor Ecosystem: VSCode vs Cursor

**Current State:**
- `visual-studio-code` (homebrew cask)
- `cursor` (not currently installed, but mentioned in plan)
- Extensions managed manually

**Nix Alternative Analysis:**
```nix
# VSCode with Extensions via Nix
programs.vscode = {
  enable = true;
  extensions = with pkgs.vscode-extensions; [
    ms-python.python
    ms-vscode.cpptools
    # Limited extension ecosystem in nixpkgs
  ];
}
```

**Evaluation Scores:**
- Workflow Impact: 4/5 (High - editor changes affect daily productivity)
- Feature Parity: 2/5 (Low - limited nix extension ecosystem)
- Maintenance Burden: 3/5 (Medium - declarative config vs manual sync)
- Cross-Platform Value: 4/5 (High - consistent across systems)

**Strategic Decision: KEEP HOMEBREW**
- **Rationale**: VSCode extension ecosystem in nixpkgs is limited
- **Risk**: High workflow disruption for marginal benefit
- **Alternative**: Consider cursor for AI-native development, keep vscode for general use

### 2. Terminal Stack: Warp vs Nix-Managed Alternatives

**Current State:**
- `warp` (homebrew cask)
- AI-powered terminal with built-in features

**Nix Alternative Analysis:**
```nix
# Alacritty + Tmux + Starship
programs.alacritty = {
  enable = true;
  settings = {
    # Full declarative config
  };
};
programs.tmux.enable = true;
programs.starship.enable = true;
```

**Evaluation Scores:**
- Workflow Impact: 3/5 (Medium - terminal is workflow-critical)
- Feature Parity: 3/5 (Medium - can replicate most features)
- Maintenance Burden: 4/5 (High benefit - full declarative config)
- Cross-Platform Value: 5/5 (Perfect - identical across systems)

**Strategic Decision: PILOT TESTING RECOMMENDED**
- **Rationale**: Good nix alternatives exist, high cross-platform value
- **Risk**: Medium - can test in parallel with warp
- **Next Steps**: Implement test configuration with alacritty + tmux

### 3. Container Runtime: Docker Desktop vs Colima + Podman

**Current State:**
- `docker` (homebrew cask) - Docker Desktop
- GUI-based container management

**Nix Alternative Analysis:**
```nix
# Colima + Podman
home.packages = with pkgs; [
  colima
  podman
  podman-compose
  lazydocker  # Already in config
];
```

**Evaluation Scores:**
- Workflow Impact: 2/5 (Low - CLI-focused workflow already)
- Feature Parity: 4/5 (High - podman is docker-compatible)
- Maintenance Burden: 4/5 (High benefit - no Docker Desktop overhead)
- Cross-Platform Value: 5/5 (Perfect - podman available everywhere)

**Strategic Decision: MIGRATION RECOMMENDED**
- **Rationale**: Docker Desktop is heavyweight, podman is docker-compatible
- **Risk**: Low - existing `lazydocker` already provides TUI management
- **Benefits**: Lighter resource usage, better nix integration

## Additional Strategic Assessments

### 4. Development Support Tools

**Current Analysis:**
- `codewhisperer` (homebrew) - Redundant with other AI tools
- `1password-cli` (homebrew) - Mac-specific optimization
- `amazon-q` (homebrew) - AWS-specific tool

**Decisions:**
- **1Password CLI**: KEEP (Mac-specific optimizations)
- **AWS Tools**: MIGRATE (already have `awscli2` in nix)
- **AI Tools**: CONSOLIDATE (evaluate redundancy)

### 5. Media & Creative Applications

**Current Analysis:**
- `figma`, `calibre`, `iina` - Mac-optimized applications
- `cleanshot` - macOS-specific screenshot tool
- `blockbench` - Specialized 3D modeling

**Strategic Decision: KEEP AS HOMEBREW**
- **Rationale**: Mac-specific optimizations, specialized workflows
- **Risk**: Very low - these are application-specific tools

## Implementation Strategy

### Phase 4B Pilot Testing

#### Week 1: Terminal Stack Evaluation
```bash
# Create test configuration
cat > test-terminal-config.nix << 'EOF'
{ config, pkgs, ... }: {
  programs.alacritty = {
    enable = true;
    settings = {
      window.opacity = 0.95;
      font.size = 14;
      # AI-like features via starship
    };
  };
  programs.tmux = {
    enable = true;
    keyMode = "vi";
    extraConfig = ''
      # Warp-like keybindings
    '';
  };
}
EOF

# Test parallel to warp
darwin-rebuild switch --flake . --show-trace
```

#### Week 2: Container Runtime Migration
```bash
# Install colima + podman
# Test docker-compose compatibility
# Benchmark performance vs Docker Desktop
```

### Migration Timeline

**Week 1-2**: Pilot testing configurations
**Week 3**: Performance and compatibility validation  
**Week 4**: Strategic decision implementation

## Risk Mitigation

### Rollback Strategy
- Keep homebrew packages during pilot testing
- Parallel installation testing (warp + alacritty)
- Performance benchmarking before migration

### Testing Protocols
1. **Functionality Testing**: All current workflows must work
2. **Performance Testing**: Resource usage, startup times
3. **Compatibility Testing**: Docker containers, development environments

## Success Metrics

### Quantitative Targets
- Container runtime: 20% reduction in memory usage
- Terminal stack: 100% configuration reproducibility
- Overall: 10-15% additional homebrew reduction

### Qualitative Targets
- Maintained or improved daily workflow experience
- Increased cross-platform compatibility
- Reduced maintenance overhead

## Recommendations

### High Priority (Implement)
1. **Container Runtime**: Migrate to colima + podman
2. **Terminal Stack**: Pilot test alacritty + tmux configuration

### Medium Priority (Evaluate)
1. **Development Tools**: Consolidate AI coding assistants
2. **CLI Tools**: Continue systematic migration

### Low Priority (Keep as Homebrew)
1. **Editor Ecosystem**: VSCode extensions via homebrew
2. **Media Applications**: Mac-optimized creative tools
3. **System Integration**: 1Password, cleanshot, etc.

## Next Steps

1. Create test configurations for terminal stack
2. Implement container runtime migration
3. Document pilot testing results
4. Update action plan based on findings

## Conclusion

Phase 4B evaluation reveals **strategic migration opportunities** for:
- Container runtime (high benefit, low risk)
- Terminal stack (medium benefit, medium risk)

**Conservative approach recommended** for:
- Editor ecosystem (limited nix extension support)
- Mac-specific applications (homebrew optimization)

**Estimated homebrew reduction**: 15-20% through strategic migrations while maintaining optimal workflow experience.
