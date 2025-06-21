#!/bin/bash

# Tier 3 Migration Testing Script
# Tests if the newly added tools are available in the nix build

echo "🔍 Testing Tier 3 Migration Tools Availability"
echo "=============================================="

# Tools to test (package_name:binary_name)
TOOLS=(
  "lazydocker:lazydocker"
  "swagger-codegen:swagger-codegen"
  "swagger-cli:swagger"
  "go-swagger:swagger"
  "ffmpeg:ffmpeg"
  "supabase-cli:supabase"
  "awscli2:aws"
  "azure-cli:az"
  "httpie:http"
  "htop:htop"
  "dive:dive"
  "ctop:ctop"
  "ansible:ansible"
)

# Test each tool
for tool_entry in "${TOOLS[@]}"; do
  package_name="${tool_entry%:*}"
  binary_name="${tool_entry#*:}"
  
  if nix-shell -p $package_name --run "which $binary_name" >/dev/null 2>&1; then
    echo "✅ $package_name ($binary_name) - Available in nixpkgs"
  else
    echo "❌ $package_name ($binary_name) - NOT available"
  fi
done

echo ""
echo "📊 Summary:"
echo "- Total tools tested: ${#TOOLS[@]}"
echo "- All tools should be available if Tier 3 migration is successful"
echo ""
echo "🚀 After 'sudo darwin-rebuild switch --flake .', these tools will be in PATH"
