# Phase 4: High-Impact Migration Assessment

## Karabiner Configuration Status ✅
- **Work Directory**: `~/02_work/_self/karabiner/` (active TypeScript-based config)
- **System Config**: `~/.config/karabiner/karabiner.json` (39KB - complex setup)
- **Priority**: HIGH - Complex custom keyboard configuration needs nix management

## Homebrew Applications Analysis (46 casks)

### HIGH PRIORITY - Development Tools → Nix
- `docker` → Use nix docker package
- `visual-studio-code` → Consider nix vscode or cursor alternative
- `orbstack` → Docker alternative, evaluate nix options
- `insomnia` → API client, check nix availability
- `tableplus` → Database client, check nix alternatives
- `ghostty` → Terminal, likely has nix package
- `warp` → Terminal, check nix availability
- `hyper` → Terminal, definitely has nix package

### MEDIUM PRIORITY - Development Adjacent
- `font-hack-nerd-font` → Move to nix fonts
- `raycast` → Launcher, keep on homebrew (Mac-specific)
- `cleanshot` → Screenshot tool, consider nix alternatives
- `keycastr` → Presentation tool, likely nix available

### KEEP ON HOMEBREW - Mac-Specific/Complex Apps
- `1password` / `1password-cli` (system integration)
- `discord` / `whatsapp` / `spotify` (media/social)
- `steam` / `prismlauncher` (gaming)
- `obs` / `notion` / `linear-linear` (productivity)
- `calibre` / `libreoffice` (documents)
- `google-chrome` / `microsoft-edge` / `vivaldi` (browsers)
- `zoom` / `transmission` (utilities)

### CLI Tools Analysis (Sample of 20)
Most CLI tools can migrate to nix:
- `bat`, `btop`, `cloc` → Already common in nix
- `cava`, `ddrescue` → Audio/disk utilities, likely available

## Next Actions Priority:

1. **KARABINER CONFIG MIGRATION** (HIGH IMPACT)
   - Integrate TypeScript config into nix-darwin
   - Manage karabiner.json via nix home-manager
   
2. **DEVELOPMENT TOOLS** (MEDIUM IMPACT)
   - Migrate docker, terminals, editors to nix
   - Focus on daily-use development apps

3. **FONT & CLI CLEANUP** (LOW EFFORT, HIGH CONSISTENCY)
   - Move remaining fonts to nix
   - Migrate obvious CLI tools
