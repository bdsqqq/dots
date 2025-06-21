# Homebrew to Nix Migration Assessment

## Current State Analysis

### 1. Nix-Managed Development Tools (Already in place)
- **Git tools**: lazygit, git (configured via programs.git)
- **CLI utilities**: ripgrep, fd, bat, eza, btop, curl, wget, jq, tree
- **Media**: mpv, yt-dlp (programs.yt-dlp)
- **Security**: sops, age, ssh-to-age
- **Node version management**: `fnm` (Fast Node Manager)
- **Shell**: zsh with oh-my-zsh, fzf

### 2. Homebrew Dependencies Requiring Migration

#### **Critical Development Tools (High Priority)**
- ✅ `go` (v1.23.3) + `go@1.20`, `go@1.21` - **MIGRATED** to nix-managed Go
- ✅ `node` (v20.12.0) + `node@16` - **MIGRATED** to nix-managed Node.js + fnm fallback
- ✅ `python@3.9`, `python@3.11`, `python@3.12`, `python@3.13` - **MIGRATED** to nix-managed Python
- `haskell-stack` - Haskell toolchain
- `openjdk`, `openjdk@11` - Java development

#### **Easy Wins (Medium Priority)**
- `gh` - GitHub CLI
- `deno` - Alternative JS runtime
- ✅ `pnpm`, `yarn` - **MIGRATED** Package managers to nix
- `postgresql@14` - Database
- `lazydocker` - Docker management
- `tmux` - Terminal multiplexer
- `starship` - Shell prompt (could replace custom theme)
- `yazi` - File manager
- `neofetch`/`fastfetch` - System info (fastfetch already in nix)

#### **Complex Cases (Lower Priority)**
- SDKMAN toolchain (Java/Scala ecosystem)
- Multiple Python versions (pyenv-like functionality needed)
- Bun runtime (BUN_INSTALL path)
- Various media/security tools

### 3. Current PATH & Toolchain Setup

**Tool Priority Order** (from PATH analysis):
1. fnm-managed Node (via homebrew fnm)
2. Homebrew binaries (`/opt/homebrew/bin`)
3. User-installed tools (bun, pnpm, go packages)
4. Nix tools (`~/.nix-profile/bin`)
5. System tools

**Potential Conflicts**:
- fnm vs nix nodejs management
- Multiple go versions via homebrew vs nix
- SDKMAN java vs nix openjdk

### 4. Migration Priority List

#### **Phase 1: Core Development Languages**
```nix
# High impact, foundational tools
- go (single version, migrate from homebrew)
- nodejs (via nix, replace fnm gradually)
- ✅ python (COMPLETED - established version management strategy)
- openjdk (replace homebrew java)
```

#### **Phase 2: CLI Development Tools**
```nix
# Easy wins, low disruption
- gh (GitHub CLI)
- tmux
- postgresql
- lazydocker
- pnpm, yarn
```

#### **Phase 3: Specialized Tools**
```nix
# Complex version management cases
- haskell-stack
- deno
- Multiple python versions
- SDKMAN alternatives
```

## Migration Strategy Recommendations

### Immediate Actions
1. **Add Go to nix**: Single version to start, remove homebrew go
2. **Test nodejs via nix**: Keep fnm as fallback initially
3. **Add GitHub CLI**: Simple replacement

### Gradual Migration Approach
1. Keep existing PATH priority during transition
2. Use nix overlays for version pinning
3. Maintain homebrew for complex multi-version scenarios initially
4. Document per-project version requirements

### Risk Mitigation
- SDKMAN integration may need custom solution
- Multiple Python versions need careful strategy
- fnm workflows might need adjustment period

## Current Tool Usage Patterns
- **Go**: Single primary version (1.23.3) with legacy versions
- **Node**: Version switching via fnm with .nvmrc files
- **Python**: Multiple system versions, likely project-specific
- **Java**: SDKMAN for version management
