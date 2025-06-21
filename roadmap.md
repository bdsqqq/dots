# nix migration roadmap - 2025 edition

this doc outlines the migration path from homebrew + manual configs to a fully declarative nix-darwin setup. based on deep analysis of current configs and 2025 best practices research.

## current state analysis (updated march 2025)

- **modular nix-darwin setup**: ✅ **completed** - implemented flat-ish modular structure
- **structure**: hosts/$(hostname)/, modules/{darwin,home-manager,shared}/, overlays/
- **home-manager modules**: shell.nix, development.nix, neovim.nix with clean domain separation
- **homebrew dependency**: 70+ packages including critical dev tools
- **config fragmentation**: dotfiles in `~/.config/`, symlinked karabiner config, manual ssh setup
- **secrets infrastructure**: ✅ **partial** - sops-nix setup with age encryption, needs completion
- **missing system management**: no macos defaults, no font management, no service management
- **neovim**: comprehensive nixvim setup with LSP, completion, AI assistance (avante), and custom plugins

## migration strategy - informed by 2025 best practices

### phase 1: establish proper nix foundation (critical first)

- [x] **flake structure overhaul following 2025 patterns** ✅ **completed**

  - [x] **migrate from flat to modular structure** (addresses current pain points) - **flat-ish approach chosen**
    - [x] create `hosts/$(hostname)/` for machine-specific configs → `hosts/mbp14.local/`
    - [x] create `modules/darwin/` for macos-specific modules → `modules/darwin/default.nix`
    - [x] create `modules/home-manager/` organized by domain → **flat-ish**: `shell.nix`, `development.nix`, `neovim.nix`
    - [x] create `modules/shared/` for cross-platform modules → `modules/shared/` (placeholder)
    - [x] create `overlays/` for package customizations → `overlays/` (placeholder)
    - [x] move `configuration.nix` → `modules/darwin/default.nix`
    - [x] split `home.nix` into logical domain modules → **clean separation achieved**
    - [x] move `neovim.nix` → `modules/home-manager/neovim.nix` (kept at top level, not nested)
    - [x] create clean host config that imports relevant modules → `hosts/mbp14.local/default.nix`
    - [x] update `flake.nix` to use new modular imports
  - [ ] add proper specialArgs and input handling for multi-system support
  - [ ] implement nixpkgs-unstable overlay for bleeding edge packages
  - [ ] setup proper flake-parts or flake-utils for organization

- [ ] **secrets infrastructure modernization** 🔄 **partial progress**

  - [x] complete sops-nix integration with age encryption → **basic setup working**
  - [ ] migrate ssh keys to declarative management
  - [ ] implement proper secret rotation strategy with age keys
  - [ ] setup separate secrets repository following security best practices

- [ ] **core development environment migration**
  - [ ] **go toolchain**: migrate `go@1.20`, `go@1.21`, latest with proper version management
  - [ ] **node ecosystem**: replace homebrew node with nix-managed versions + corepack
  - [ ] **python environment**: consolidate `python@3.9-3.13` with proper venv integration
  - [ ] **rust toolchain**: implement via rust-overlay or fenix for better control
  - [ ] **java stack**: migrate `openjdk@11` and variants to nix
  - [ ] **haskell**: move `haskell-stack` to nix-managed ghc + stack

### phase 2: application ecosystem strategic migration

- [ ] **development tools prioritization**

  - [ ] **nixvim optimization**: current setup is excellent, maybe add more LSP servers for your specific dev stack
  - [ ] **terminal stack**: evaluate warp vs nix-managed alternatives (alacritty/kitty + tmux)
  - [ ] **editors**: vscode via nix with extensions vs cursor as managed cask
  - [ ] **docker management**: nix-daemon + colima/podman via nix instead of docker desktop

- [ ] **cli tools modernization (2025 replacements)**

  - [ ] replace basic tools: `bat` > `cat`, `fd` > `find`, `ripgrep` > `grep`, `eza` > `ls`
  - [ ] modern git stack: `gh`, `git-delta`, `lazygit`, `gitui`
  - [ ] file management: `broot`, `ranger`/`yazi`, `fzf` with proper integration
  - [ ] system monitoring: `btop`, `htop`, `bandwhich`, `dust`

- [ ] **media/codec stack migration**
  - [ ] migrate massive ffmpeg ecosystem to nix versions
  - [ ] image processing: `imagemagick`, `exiftool`, `imagesnap`
  - [ ] compression: `p7zip`, `lz4`, `xz`, `zstd` - all via nix

### phase 3: system configuration declarative management

- [ ] **macos system defaults comprehensive setup (2025 approach)**

  - [ ] dock: `autohide`, `orientation`, `show-recents = false`, app pinning
  - [ ] finder: `ShowAllExtensions`, `PathBar`, `AppleShowAllFiles`, view defaults
  - [ ] keyboard: `fnState`, `AppleKeyboardUIMode`, repeat rates, modifier keys
  - [ ] trackpad: gesture configuration, tracking speed, click behavior
  - [ ] security: firewall, gatekeeper, privacy settings, screensaver

- [ ] **shell environment complete overhaul**

  - [ ] zsh via home-manager with modern plugin management (no oh-my-zsh bloat)
  - [ ] starship prompt configuration (already partially present)
  - [ ] environment variables consolidated and properly scoped
  - [ ] shell functions and aliases organized by domain

- [ ] **font and appearance declarative management**
  - [ ] system fonts via `fonts.packages` (monaspace, sf-pro, etc.)
  - [ ] terminal themes and color schemes
  - [ ] application-specific theming where supported

### phase 4: advanced integration and automation

- [ ] **configuration symlink resolution**

  - [ ] migrate karabiner config from `~/02_work/_self/karabiner` to nix management
  - [ ] consolidate ALL dotfiles into home-manager (no more manual symlinks)
  - [ ] implement proper xdg directory management

- [ ] **services and automation**

  - [ ] postgresql@14 → nix-managed postgres with proper data dir
  - [ ] unbound dns configuration via nix-darwin
  - [ ] custom launchd services for development workflow
  - [ ] log rotation and system maintenance automation

- [ ] **networking and development infrastructure**
  - [ ] ssh configuration via home-manager with proper key management
  - [ ] local development services (redis, memcached, etc.)
  - [ ] vpn configurations if applicable

### phase 5: optimization and maintenance (ongoing)

- [ ] **performance optimization**

  - [ ] nix store optimization and garbage collection automation
  - [ ] binary cache setup for faster rebuilds
  - [ ] build parallelization configuration

- [ ] **monitoring and updates**
  - [ ] automated security updates for critical packages
  - [ ] configuration drift detection
  - [ ] system health monitoring integration

## 2025 nix ecosystem updates to leverage

### modern flake patterns

```nix
# flake-parts based structure (current best practice)
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixpkgs-stable.url = "github:NixOS/nixpkgs/nixos-24.11";
    flake-parts.url = "github:hercules-ci/flake-parts";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # modern overlays
    fenix.url = "github:nix-community/fenix";
    rust-overlay.url = "github:oxalica/rust-overlay";
  };
}
```

### secrets management evolution

- sops-nix with age encryption (current standard)
- separate secrets repository pattern
- ssh key derivation for age keys
- per-environment secret scoping

### package management strategy (2025 priorities)

1. **nixpkgs-unstable first** - most packages are fresher than homebrew now
2. **homebrew via nix-darwin** - only for truly mac-specific apps
3. **custom overlays** - for patches or specific versions
4. **flake inputs** - for packages from other flakes

## critical migration decisions

### neovim: already using nixvim excellently

**current**: comprehensive nixvim setup with LSP, blink-cmp, avante AI, custom themes
**status**: ✅ already optimal - one of the best parts of your setup

- full declarative plugin management
- advanced LSP integration with telescope
- AI assistance with avante plugin
- custom vesper colorscheme integration

### terminal: warp vs nix alternatives

**current**: warp (homebrew cask)
**recommendation**: evaluate alacritty/kitty + tmux via nix

- better performance and customization
- full declarative configuration
- cross-platform compatibility

### node version management

**current**: multiple homebrew node versions
**recommendation**: nix-managed node with corepack

- cleaner version switching
- project-specific node versions via flakes
- no global npm pollution

## implementation timeline (realistic 2025 estimate)

### weeks 1-2: foundation

- **restructure flake from flat to modular** (critical organizational improvement)
- implement proper secrets management
- migrate critical development tools (go, node, python)

### weeks 3-4: applications and system

- strategic application migration
- implement comprehensive macos defaults
- resolve configuration symlink issues

### weeks 5-6: polish and advanced features

- optimize nixvim LSP servers for your dev stack (go, node, python, etc.)
- implement advanced system services
- optimize performance and reliability

### weeks 7-8: testing and hardening

- full system rebuild testing
- disaster recovery procedures
- cross-machine compatibility verification

## success metrics

- **95% homebrew reduction** - only essential mac-only casks remain
- **single command setup** - `darwin-rebuild switch --flake .` for complete system
- **sub-30s rebuild times** - optimized for development workflow
- **zero manual configuration** - everything declarative and version controlled
- **cross-machine compatibility** - identical setup across multiple macs

## expected timeline: 6-8 weeks

realistic estimate for complete migration assuming dedicated focus. could extend if complex application compatibility issues arise or custom packaging needed.

## modern anti-patterns to avoid (learned from 2025 community)

- **flat flake structures** - becomes unmaintainable with multiple machines/configs
- mixing imperative and declarative management
- over-engineering with unnecessary abstractions
- ignoring darwin-specific quirks and limitations
- incomplete secrets management (security risk)
- not testing full system rebuilds regularly

## structural decision: flat-ish approach (march 2025)

### why we chose flat-ish over deep modular

**original plan**: deep nesting like `modules/home-manager/shell/zsh.nix`, `modules/home-manager/editors/neovim.nix`

**implemented approach**: flat-ish structure with domain separation at top level:
- `modules/home-manager/shell.nix` - all shell-related config
- `modules/home-manager/development.nix` - all dev tools and languages  
- `modules/home-manager/neovim.nix` - editor config (substantial enough to warrant separation)

### benefits achieved

- **eliminated shallow files**: no more `default.nix` files that just import one thing
- **clear domain boundaries**: easy to find shell config vs dev tools vs editor config
- **easy navigation**: 3-4 meaningful files instead of dozens of nested directories
- **reduced complexity**: simpler imports, less cognitive overhead
- **maintainable**: each file has substantial content worth organizing separately

### structure comparison

```
# avoided this over-modularized approach:
modules/home-manager/
├── shell/
│   ├── default.nix  # shallow, just imports zsh.nix
│   └── zsh.nix      # actual content
├── editors/
│   └── neovim.nix   # could be substantial
└── development/
    ├── default.nix  # shallow, imports everything
    ├── git.nix      # small file
    ├── node.nix     # small file  
    └── go.nix       # small file

# implemented this flat-ish approach:
modules/home-manager/
├── default.nix      # imports main modules
├── shell.nix        # zsh + starship + shell tools
├── development.nix  # git + node + go + dev tools
└── neovim.nix       # comprehensive editor config
```

## modular structure migration plan

### current flat structure problems

```
/private/etc/nix-darwin/
├── flake.nix           # entry point + system config mixed
├── configuration.nix   # darwin + system mixed
├── home.nix           # user + app configs mixed
├── neovim.nix         # single app (good)
└── ...                # will become dozens of files
```

### actual implemented structure ✅

```
/private/etc/nix-darwin/
├── flake.nix                           # clean entry point
├── hosts/                              # machine-specific configs
│   └── mbp14.local/
│       └── default.nix                # host config (imports modules)
├── modules/                           # reusable modules
│   ├── darwin/                        # macos-specific
│   │   └── default.nix               # system defaults (needs expansion)
│   ├── home-manager/                 # user environment - flat-ish approach
│   │   ├── default.nix              # imports main modules + user config
│   │   ├── shell.nix                # zsh + starship + shell tools
│   │   ├── development.nix          # git + node + go + dev tools
│   │   └── neovim.nix              # comprehensive editor config
│   └── shared/                       # cross-platform (placeholder)
└── overlays/                         # package customizations (placeholder)
```

### originally planned deep structure (not implemented)

```
# this was the original plan but proved over-modularized:
modules/home-manager/
├── shell/
│   ├── default.nix
│   ├── zsh.nix
│   └── starship.nix
├── editors/
│   └── neovim.nix
└── development/
    ├── git.nix
    ├── node.nix
    └── go.nix
```

### benefits achieved with flat-ish structure ✅

- **easier multi-machine support** - `hosts/mbp14.local/` pattern supports multiple machines
- **logical organization** - clear domain separation: shell vs development vs editor
- **reusable modules** - modular structure allows sharing across hosts when needed
- **cleaner flake.nix** - imports single host config instead of dozen files
- **better maintenance** - change dev tools once in `development.nix`, affects whole system
- **eliminated shallow files** - no more `default.nix` files that just import single items
- **easy navigation** - 3-4 meaningful files instead of deeply nested directories
