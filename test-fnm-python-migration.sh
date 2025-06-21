#!/bin/bash

echo "=== Node.js/Python Migration Test Script ==="
echo ""

echo "=== Current homebrew packages ==="
echo "fnm and node packages:"
brew list | grep -E "(fnm|node)"
echo ""
echo "python packages:"  
brew list | grep python
echo ""

echo "=== PATH Analysis ==="
echo "Current PATH:"
echo $PATH | tr ':' '\n' | nl
echo ""

echo "=== Tool Locations ==="
echo "fnm: $(which fnm 2>/dev/null || echo 'not found')"
echo "node: $(which node 2>/dev/null || echo 'not found')" 
echo "python3: $(which python3 2>/dev/null || echo 'not found')"
echo "pip3: $(which pip3 2>/dev/null || echo 'not found')"
echo ""

echo "=== Version Check ==="
if command -v fnm >/dev/null 2>&1; then
  echo "fnm version: $(fnm --version)"
fi

if command -v python3 >/dev/null 2>&1; then
  echo "python3 version: $(python3 --version)"
  echo "python3 path: $(which python3)"
fi

echo ""
echo "=== Migration Steps ==="
echo "1. Apply nix config: sudo darwin-rebuild switch --flake ."
echo "2. Remove homebrew packages:"
echo "   brew uninstall --ignore-dependencies fnm node npm"
echo "   brew uninstall --ignore-dependencies python@3.11 python@3.12 python@3.13 python@3.9"
echo "3. Restart shell or source ~/.zshrc"
echo "4. Test fnm install node 18"
echo "5. Verify python3 points to nix version"
