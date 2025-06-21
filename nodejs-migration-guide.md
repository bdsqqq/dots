# Node.js Migration: Homebrew to Nix

## Migration Summary

✅ **Completed**: Added nix-managed Node.js development environment to `modules/home-manager/development.nix`

## What's Included

### Core Node.js Tools (from nix)
- `nodejs` - Latest stable Node.js version
- `npm` - Package manager (included with Node.js)
- `pnpm` - Fast, disk-space efficient package manager
- `bun` - Fast all-in-one JavaScript runtime

### Development Tools (from nix)
- `typescript` - TypeScript compiler
- `typescript-language-server` - Language server for editors
- `eslint` - JavaScript linter
- `prettier` - Code formatter

### Version Management Strategy
- **Primary**: Nix-managed Node.js (stable, system-wide)
- **Fallback**: fnm for project-specific versions (.nvmrc support)
- **Bleeding-edge**: Available via `pkgs.unstable.nodejs`

## Next Steps

### 1. Apply Configuration
```bash
# Apply the new configuration (requires sudo)
sudo darwin-rebuild switch --flake .

# Or for users without sudo
darwin-rebuild switch --flake . --use-remote-sudo
```

### 2. Test Setup
```bash
# Run the test script
./test-nodejs-setup.sh
```

### 3. Verify Migration
```bash
# Check which node is being used
which node  # Should show nix store path

# Check versions
node --version
npm --version
pnpm --version
bun --version
```

### 4. Remove Homebrew Node.js (Optional)
```bash
# Once satisfied with nix setup, remove homebrew versions
brew uninstall node
brew uninstall pnpm
# Keep fnm for project-specific versions if needed
```

## Usage Patterns

### Default Development
```bash
# Use nix-managed tools (system-wide)
node --version
npm install
pnpm install
bun install
```

### Project-Specific Versions
```bash
# Use fnm for projects with .nvmrc
echo "18.0.0" > .nvmrc
fnm use  # Switches to project-specific version
```

### Corepack Support
```bash
# Enable corepack for yarn/pnpm management
corepack enable
```

## Benefits of This Approach

1. **Declarative**: Node.js version locked in nix configuration
2. **Reproducible**: Same environment across all machines
3. **No Conflicts**: Nix isolates packages from system
4. **Fast**: pnpm and bun for efficient package management
5. **Flexible**: fnm still available for project-specific needs

## Environment Variables

The following are automatically configured:
- `COREPACK_ENABLE_STRICT=0` - Enables corepack for modern npm features
- `PNPM_HOME` - For pnpm global packages
- `BUN_INSTALL` - For bun global packages

## Troubleshooting

### If nix-managed node isn't found:
1. Check PATH order: `echo $PATH`
2. Rebuild configuration: `darwin-rebuild switch --flake .`
3. Restart terminal/shell

### If packages conflict:
1. Remove homebrew versions first
2. Clear npm/pnpm caches
3. Restart development environment

### For older projects:
1. Use fnm for specific Node.js versions
2. Create project-specific .nvmrc files
3. Use `fnm use` to switch versions per project
