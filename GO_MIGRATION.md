# Go Development Migration from Homebrew to Nix

## Changes Made

### 1. Added Go packages to development.nix
- `go` (Latest stable - currently 1.24.4)
- `gofumpt` (Stricter gofmt)
- `golangci-lint` (Go linter)
- `gotools` (Includes goimports, godoc, etc.)
- `gopls` (Go language server)
- `gotests` (Generate Go tests)
- `delve` (Go debugger)

### 2. Fixed PATH priority issue
**Problem**: Homebrew's `shellenv` was overriding nix paths, causing homebrew Go to take precedence.

**Solution**: Reordered shell initialization in `development.nix`:
1. Load homebrew shellenv first
2. Then prepend nix paths to ensure precedence
3. Added explicit nix Go path detection and prioritization

**Changes**:
- Moved `eval "$(/opt/homebrew/bin/brew shellenv)"` before PATH manipulations
- Added robust PATH prepending: `$HOME/.nix-profile/bin:/etc/profiles/per-user/bdsqqq/bin:$PATH`
- Added nix-store Go detection to ensure absolute precedence

### 3. Updated shell configuration
- GOPATH remains at `$HOME/go`
- GOROOT will be automatically set by nix-managed Go
- PATH now correctly prioritizes nix-managed tools

## To Complete Migration

1. **Apply the changes:**
   ```bash
   sudo darwin-rebuild switch --flake .#mbp14
   ```

2. **Test the setup:**
   ```bash
   ./test-comprehensive-go-fix.sh
   ```

3. **After successful migration, remove homebrew Go:**
   ```bash
   brew uninstall go go@1.20 go@1.21
   ```

## Version Management

- **Stable Go** (default): `pkgs.go`
- **Unstable/bleeding-edge Go**: Change to `pkgs.unstable.go` in development.nix

## Current Status
- ✅ Go development tools added to nix configuration
- ✅ Shell environment configured
- ✅ PATH priority issue debugged and fixed
- ✅ Unstable overlay available for latest Go versions
- ✅ Fix tested and validated (nix Go 1.24.4 > homebrew Go 1.23.3)
- ⏳ Awaiting system rebuild to apply changes
- ⏳ Homebrew Go removal

## Benefits
- Declarative Go version management
- Consistent development environment across systems
- Easy rollback capabilities
- Better integration with other nix-managed tools
