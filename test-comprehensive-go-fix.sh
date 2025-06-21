#!/bin/bash

# Test script to verify Go PATH configuration after the fix
echo "=== Testing Go PATH Configuration (After Fix) ==="

# Simulate the new shell initialization sequence
echo -e "\n0. Simulating new shell initialization:"
# Save current PATH
ORIGINAL_PATH="$PATH"

# Reset PATH to minimal system PATH
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"

# Simulate homebrew shellenv
eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || echo "Homebrew not found"

# Apply our new PATH prioritization
export PATH="$HOME/.nix-profile/bin:/etc/profiles/per-user/bdsqqq/bin:$PATH"
export PATH="$HOME/go/bin:$PATH"

# Force nix Go to take precedence
if command -v nix-env >/dev/null 2>&1; then
  NIX_GO_PATH=$(nix-env -q --installed --out-path go 2>/dev/null | grep -o '/nix/store/[^[:space:]]*' | head -1)
  if [ -n "$NIX_GO_PATH" ] && [ -d "$NIX_GO_PATH/bin" ]; then
    export PATH="$NIX_GO_PATH/bin:$PATH"
    echo "✓ Added nix Go path: $NIX_GO_PATH/bin"
  fi
fi

# Test 1: PATH priority after fix
echo -e "\n1. PATH priority after fix (first 10 entries with homebrew/nix):"
echo $PATH | tr ':' '\n' | grep -E "(homebrew|nix)" | head -10

# Test 2: Which Go binary is being used after fix
echo -e "\n2. Which Go binary after fix:"
which go

# Test 3: Go version and installation path after fix
echo -e "\n3. Go version and GOROOT after fix:"
go version 2>/dev/null && go env GOROOT 2>/dev/null || echo "Go not accessible"

# Test 4: Check available Go installations
echo -e "\n4. Available Go installations:"
for path in "$HOME/.nix-profile/bin/go" "/etc/profiles/per-user/bdsqqq/bin/go" "/opt/homebrew/bin/go"; do
    if [ -f "$path" ]; then
        echo "✓ Found: $path - $($path version 2>/dev/null || echo 'version unknown')"
    else
        echo "✗ Not found: $path"
    fi
done

# Test 5: Nix store Go check
echo -e "\n5. Nix store Go installations:"
if command -v nix-env >/dev/null 2>&1; then
    nix-env -q --installed go 2>/dev/null || echo "No Go found in nix profile"
else
    echo "nix-env not available"
fi

echo -e "\n=== Fix Validation ==="
CURRENT_GO=$(which go)
if echo "$CURRENT_GO" | grep -q "/nix/store\|\.nix-profile\|/etc/profiles/per-user"; then
    echo "✅ SUCCESS: Nix-managed Go takes precedence ($CURRENT_GO)"
else
    echo "❌ FAILURE: Homebrew Go still takes precedence ($CURRENT_GO)"
fi

# Restore original PATH
export PATH="$ORIGINAL_PATH"
