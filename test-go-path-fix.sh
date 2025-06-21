#!/bin/bash

echo "Testing Go PATH fix"
echo "==================="

# Simulate the fixed PATH setup
export PATH="/etc/profiles/per-user/bdsqqq/bin:$HOME/.nix-profile/bin:$PATH"

echo "Current PATH (first 5 entries):"
echo $PATH | tr ':' '\n' | head -5

echo -e "\nGo location and version:"
which go
go version

echo -e "\nOther Go tools:"
echo "gofmt: $(which gofmt)"
echo "golangci-lint: $(which golangci-lint)"
echo "gopls: $(which gopls)"
