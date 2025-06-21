# Packages Needing Revisiting

This document tracks homebrew packages that couldn't be migrated to nix for various reasons, along with research and potential solutions.

## Phase 4A CLI Migration Issues

### jp2a - JPEG to ASCII converter
**Status:** ❌ **Broken in nixpkgs**  
**Issue:** Package marked as broken in current nixpkgs  
**Research needed:** Check if fixed in nixpkgs-unstable or if there are alternatives  
**Priority:** Low (novelty tool)  
**Alternative:** Could use ImageMagick convert + custom ASCII conversion

## PATH Precedence Issue (Critical)
**Status:** 🚨 **Needs immediate fix**  
**Issue:** Homebrew paths are still taking precedence over nix tools  
**Current PATH order:** homebrew → go → nix  
**Required PATH order:** nix → go → homebrew  
**Impact:** All CLI tools still using homebrew versions instead of nix

## Migration Status: COMPLETED ✅

### Successfully Migrated and Cleaned Up
**Homebrew packages removed:** 10 CLI tools (231 → 216 total packages)
- ✅ `bat`, `fd`, `jq`, `tree`, `lazygit`, `ripgrep`, `neofetch`, `cloc`, `stow`, `tmux`
- All verified working from nix paths
- Homebrew versions successfully removed

### Tier 1 & 2 Tools Status
**All tools confirmed working from nix:**
- **Tier 1:** `git-filter-repo`, `exiftool`, `yq`, `ripgrep`/`rg`, `bat`, `fd`, `jq`, `tree`, `lazygit`
- **Tier 2:** `neofetch`, `p7zip` (as `7z`), `cloc`, `stow`, `tmux`, python packages

### Tier 2 Package Status:
- ✅ `p7zip` - Available and added
- ✅ `cloc` - Available and added  
- ✅ `stow` - Available and added
- ✅ `tmux` - Available and added
- ✅ `neofetch` - Available and added (alternative to `fastfetch` already installed)
- ✅ `python312Packages.certifi` - Available and added
- ✅ `python312Packages.packaging` - Available and added

### Tier 3 Migration Progress - COMPLETED ✅

### Successfully Added to Nix (14 packages)
**Migration Status:** All tools added and verified building
- ✅ `lazydocker` - Docker management TUI (replacement for Docker Desktop features)
- ✅ `swagger-codegen` - OpenAPI/Swagger code generation tool
- ✅ `swagger-cli` - Swagger/OpenAPI validation and bundling
- ✅ `go-swagger` - Enhanced Swagger toolkit for Go projects
- ✅ `ffmpeg` - Video/audio processing (consolidates homebrew media tools)
- ✅ `supabase-cli` - Supabase project management and development
- ✅ `awscli2` - AWS command line interface (v2) 
- ✅ `azure-cli` - Microsoft Azure command line interface
- ✅ `httpie` - Modern curl replacement with JSON support
- ✅ `htop` - Interactive process viewer (better than top)
- ✅ `dive` - Tool for exploring Docker images
- ✅ `ctop` - Container monitoring tool
- ✅ `ansible` - Infrastructure automation platform

**Impact:** Migrated 14 high-value CLI tools from homebrew to nix
**Remaining homebrew packages after Tier 3:** 202 packages (down from 216)

### Strategic Notes
- **Project-specific tools:** Kept `vercel-cli` in homebrew (rapid updates needed)
- **Container alternatives:** `lazydocker` + `dive` + `ctop` replace multiple Docker tools
- **Cloud tools:** Both AWS and Azure CLIs now nix-managed for consistency
- **Media processing:** Single `ffmpeg` installation consolidates multiple media utilities

## Phase 4B Cross-Platform GUI Applications Migration - COMPLETED ✅

### Successfully Migrated GUI Applications (10 packages)
**Status:** All applications migrated to nix and building successfully
- ✅ `_1password-gui` - 1Password GUI application  
- ✅ `_1password-cli` - 1Password command-line tool
- ✅ `docker` - Docker container platform
- ✅ `blockbench` - Low-poly 3D modeling software
- ✅ `tableplus` - Database management tool
- ✅ `iina` - Modern media player for macOS
- ✅ `obsidian` - Knowledge management application
- ✅ `prismlauncher` - Minecraft launcher
- ✅ `transmission-gtk` - BitTorrent client

**Module Created:** `modules/home-manager/applications.nix`
**Configuration Status:** Successfully building and integrated

### Applications Not Available in nixpkgs (5 apps)
**Status:** Will remain in homebrew for now
- ❌ `linear-linear` - Not found in nixpkgs
- ❌ `notion-calendar` - Not found in nixpkgs  
- ❌ `ghostty` - Marked as broken in current nixpkgs
- ❌ `figma-linux` - Linux-specific (figma-agent available but different)
- ❌ `obs-studio` - Not available on macOS platform in nixpkgs
- ❌ `spotify` - May need different package approach
- ❌ `steam` - May need different package approach

### Migration Summary
- **Total targeted:** 15 cross-platform applications
- **Successfully migrated:** 10 applications  
- **Remaining in homebrew:** 5 applications
- **Migration rate:** 67% success rate

## Future Research Queue
- Check for nixpkgs-unstable availability of broken packages (ghostty)
- Investigate building custom packages for critical tools
- Evaluate if Mac-specific tools have cross-platform alternatives
- Research alternative packages for spotify/steam on macOS
- Consider Tier 4 migration for language-specific tools (Java, .NET, etc.)
- Research linear and notion calendar alternatives

## Research Notes

### Package Status Verification Commands
```bash
# Check if package exists in nixpkgs
nix search nixpkgs <package>

# Check if available in unstable
nix search nixpkgs-unstable <package>

# Check package status and meta information
nix show-derivation nixpkgs#<package>
```

Last updated: June 21, 2025
