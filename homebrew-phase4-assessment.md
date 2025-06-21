# Homebrew Phase 4 Assessment

**Current State:** 234 total homebrew packages (46 casks + 188 formulae)

## Categorization Analysis

### **HIGH PRIORITY FOR NIX MIGRATION** (Can be migrated to improve system consistency)
**Development Tools & CLI Utilities:**
- `git`, `git-lfs`, `git-filter-repo`, `git-review`, `lazygit` - Core git tools
- `gh` - GitHub CLI
- `fd`, `ripgrep`, `bat`, `tree`, `jq`, `yq` - Modern CLI tools 
- `tmux`, `starship` - Terminal enhancement
- `btop`, `neofetch` - System monitoring
- `cloc` - Code analysis
- `stow` - Dotfile management
- `watchexec` - File watching
- `yazi` - File manager
- `pandoc` - Document conversion

**Programming Language Tools:**
- `deno` - Alternative JS runtime
- `pnpm`, `yarn` - Node package managers (can be replaced with nix equivalents)
- `haskell-stack` - Haskell build tool

**Media Tools:**
- `ffmpeg` and related codecs - Video processing
- `yt-dlp` - Video downloader
- `imagesnap` - Camera capture

**Estimated Migration Impact:** ~25-30 packages → Nix

### **KEEP ON HOMEBREW** (Mac-specific or better via homebrew)
**Mac System Integration:**
- `karabiner-elements` - Keyboard customization (Mac-specific)
- `sudo-touchid` - TouchID for sudo (Mac-specific)
- `screenresolution` - Display management (Mac-specific)

**Databases & Services:**
- `postgresql@14` - Database (may conflict with nix postgres)
- `sqld`, `turso` - SQLite-related tools

**Complex Applications:**
- All GUI casks (46 apps) - Generally better maintained via homebrew
- `docker`, `orbstack` - Container platforms (Mac-optimized)
- `openjdk`, `openjdk@11` - Java (homebrew handles Mac integration better)

**Estimated Keep:** ~15-20 core tools + all 46 casks = ~65 packages

### **EVALUATE** (Potential for migration but needs testing)
**CLI Tools:**
- `curl`, `wget` equivalents (if not already in nix)
- `cmake`, `gcc` - Build tools (check nix compatibility)
- `vercel-cli`, `supabase` - Platform CLIs
- `spicetify-cli` - Spotify customization

**Libraries:**
- Various codec libraries (currently 50+ lib* packages)
- May be automatically handled by nix packages that depend on them

**Estimated Evaluation Needed:** ~20-30 packages

## Dev Tool Conflicts Identified

**RESOLVED:**
- ✅ Node.js ecosystem (migrated to fnm)
- ✅ Python ecosystem (partial migration)
- ✅ Go toolchain (migrated)

**REMAINING CONFLICTS:**
- `git` ecosystem (6 packages) - Should migrate to nix for consistency
- No major language runtime conflicts detected

## Migration Recommendations

### Phase 4A: Core CLI Tools (Week 1)
- Migrate common CLI utilities (fd, ripgrep, bat, etc.)
- Move git ecosystem to nix
- Test development workflow compatibility

### Phase 4B: Media & Specialized Tools (Week 2)
- Migrate ffmpeg and media tools
- Move language-specific tools (deno, haskell-stack)
- Test multimedia workflows

### Phase 4C: Library Cleanup (Week 3)
- Identify which libraries are still needed after tool migration
- Clean up orphaned dependencies
- Optimize nix expressions

## Expected Outcomes

**Conservative Estimate:**
- **Migrate to Nix:** 40-50 packages (~20% of total)
- **Keep on Homebrew:** ~80-90 packages (casks + Mac-specific tools)
- **Total Reduction:** From 234 to ~180-190 packages

**Optimistic Estimate:**
- **Migrate to Nix:** 60-70 packages (~30% of total)
- **Keep on Homebrew:** ~70-80 packages
- **Total Reduction:** From 234 to ~160-170 packages

## Risk Assessment

**Low Risk:**
- CLI tool migration (easy rollback)
- Media tools (self-contained)

**Medium Risk:**
- Git ecosystem migration (critical for development)
- Database tools (could affect local development)

**High Risk:**
- Library migration (could break dependent applications)
- System-level tools (could affect OS integration)

## Next Steps

1. Start with Phase 4A low-risk CLI tools
2. Test each migration thoroughly in development workflow
3. Create rollback procedures for critical tools
4. Update roadmap with realistic timeline based on testing results
