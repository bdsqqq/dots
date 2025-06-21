#!/bin/bash

echo "Testing Tier 2 migration..."
echo "============================="

# Test PATH precedence for existing tools
echo "1. Testing PATH precedence..."
echo "ripgrep location: $(which rg 2>/dev/null || echo 'NOT FOUND')"
echo "yq location: $(which yq 2>/dev/null || echo 'NOT FOUND')"
echo "bat location: $(which bat 2>/dev/null || echo 'NOT FOUND')"
echo "jq location: $(which jq 2>/dev/null || echo 'NOT FOUND')"
echo "fd location: $(which fd 2>/dev/null || echo 'NOT FOUND')"

echo ""
echo "2. Testing nix-managed versions..."
echo "ripgrep (nix): $(/etc/profiles/per-user/bdsqqq/bin/rg --version | head -1)"
echo "yq (nix): $(/etc/profiles/per-user/bdsqqq/bin/yq --version 2>/dev/null)"
echo "bat (nix): $(/etc/profiles/per-user/bdsqqq/bin/bat --version)"
echo "jq (nix): $(/etc/profiles/per-user/bdsqqq/bin/jq --version)"
echo "fd (nix): $(/etc/profiles/per-user/bdsqqq/bin/fd --version)"

echo ""
echo "3. Testing new Tier 2 packages in nix..."
echo "p7zip: $(/etc/profiles/per-user/bdsqqq/bin/7z 2>/dev/null | head -2 || echo 'NOT INSTALLED')"
echo "cloc: $(/etc/profiles/per-user/bdsqqq/bin/cloc --version 2>/dev/null || echo 'NOT INSTALLED')"
echo "stow: $(/etc/profiles/per-user/bdsqqq/bin/stow --version 2>/dev/null | head -1 || echo 'NOT INSTALLED')"
echo "tmux: $(/etc/profiles/per-user/bdsqqq/bin/tmux -V 2>/dev/null || echo 'NOT INSTALLED')"

echo ""
echo "4. Testing homebrew versions for comparison..."
echo "ripgrep (brew): $(/opt/homebrew/bin/rg --version | head -1)"
echo "yq (go): $(${HOME}/go/bin/yq --version 2>/dev/null || echo 'NOT FOUND')"
echo "bat (brew): $(/opt/homebrew/bin/bat --version)"
echo "jq (brew): $(/opt/homebrew/bin/jq --version)"

echo ""
echo "PATH order (first 10 entries):"
echo $PATH | tr ':' '\n' | head -10
