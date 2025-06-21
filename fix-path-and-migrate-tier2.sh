#!/bin/bash

set -e

echo "🔧 Fixing PATH precedence and completing Tier 2 migration..."
echo "============================================================="

# Step 1: Check current state
echo "📊 Current PATH order:"
echo $PATH | tr ':' '\n' | head -5 | nl

# Step 2: Check if Tier 2 packages are in development.nix
echo "📋 Checking development.nix for Tier 2 packages..."
if grep -q "p7zip\|cloc\|stow\|tmux" modules/home-manager/development.nix; then
    echo "✅ Tier 2 packages found in development.nix"
else
    echo "❌ Tier 2 packages missing from development.nix"
    exit 1
fi

# Step 3: Explain the PATH issue
echo "🚨 PATH Issue Analysis:"
echo "   Current: homebrew → go → nix (WRONG)"
echo "   Target:  nix → go → homebrew (CORRECT)"
echo ""
echo "The issue is in development.nix where we:"
echo "1. Load homebrew FIRST with 'eval \"\$(/opt/homebrew/bin/brew shellenv)\"'"
echo "2. Then try to prepend nix paths - but homebrew is already in PATH"
echo ""

# Step 4: Show the fix
echo "📝 The fix in development.nix:"
echo "   OLD: eval homebrew first, then export nix paths"
echo "   NEW: Load homebrew first, then PREPEND nix paths properly"
echo ""

# Step 5: Test nix tools directly
echo "🧪 Testing nix-managed tools directly:"
if [ -f /etc/profiles/per-user/bdsqqq/bin/rg ]; then
    echo "✅ ripgrep: $(/etc/profiles/per-user/bdsqqq/bin/rg --version | head -1)"
else
    echo "❌ ripgrep not found in nix profile"
fi

if [ -f /etc/profiles/per-user/bdsqqq/bin/yq ]; then
    echo "✅ yq: $(/etc/profiles/per-user/bdsqqq/bin/yq --version)"
else
    echo "❌ yq not found in nix profile"
fi

# Step 6: Check if packages are ready for installation
echo "🔍 Checking package availability:"
for pkg in p7zip cloc stow tmux; do
    if nix-env -f '<nixpkgs>' -qaP "$pkg" | grep -q "$pkg"; then
        echo "✅ $pkg available in nixpkgs"
    else
        echo "❌ $pkg not found in nixpkgs"
    fi
done

echo ""
echo "🎯 Next steps to complete migration:"
echo "1. Apply configuration: Run 'sudo darwin-rebuild switch --flake .'"
echo "2. Test PATH order in new shell session"
echo "3. Remove successfully migrated homebrew packages"
echo ""
echo "📋 Homebrew packages ready for removal after successful migration:"
brew list | grep -E "^(ripgrep|bat|fd|jq|p7zip|cloc|stow|tmux)\$" | head -10
