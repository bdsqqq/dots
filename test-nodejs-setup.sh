#!/usr/bin/env bash
# Test Node.js setup after nix rebuild

echo "🧪 Testing Node.js Development Environment"
echo "========================================="

# Test Node.js and npm (from nix)
echo
echo "📦 Node.js & npm versions:"
if command -v node &> /dev/null; then
    echo "✅ node: $(node --version)"
else
    echo "❌ node: not found"
fi

if command -v npm &> /dev/null; then
    echo "✅ npm: $(npm --version)"
else
    echo "❌ npm: not found"
fi

# Test pnpm (from nix)
echo
echo "📦 pnpm version:"
if command -v pnpm &> /dev/null; then
    echo "✅ pnpm: $(pnpm --version)"
else
    echo "❌ pnpm: not found"
fi

# Test bun (from nix)
echo
echo "📦 bun version:"
if command -v bun &> /dev/null; then
    echo "✅ bun: $(bun --version)"
else
    echo "❌ bun: not found"
fi

# Test TypeScript (from nix)
echo
echo "📦 TypeScript version:"
if command -v tsc &> /dev/null; then
    echo "✅ tsc: $(tsc --version)"
else
    echo "❌ tsc: not found"
fi

# Test ESLint (from nix)
echo
echo "📦 ESLint version:"
if command -v eslint &> /dev/null; then
    echo "✅ eslint: $(eslint --version)"
else
    echo "❌ eslint: not found"
fi

# Test Prettier (from nix)
echo
echo "📦 Prettier version:"
if command -v prettier &> /dev/null; then
    echo "✅ prettier: $(prettier --version)"
else
    echo "❌ prettier: not found"
fi

# Test fnm (still available as fallback)
echo
echo "📦 fnm (for project-specific versions):"
if command -v fnm &> /dev/null; then
    echo "✅ fnm: $(fnm --version)"
    echo "   Installed versions: $(fnm list)"
else
    echo "❌ fnm: not found"
fi

# Test creating a simple project
echo
echo "🚀 Testing package manager functionality:"
echo "Creating temporary test project..."

TEST_DIR="/tmp/nodejs-test-$$"
mkdir -p "$TEST_DIR"
cd "$TEST_DIR"

# Test npm init
echo "  Testing npm init..."
echo '{}' > package.json

# Test pnpm
if command -v pnpm &> /dev/null; then
    echo "  Testing pnpm add..."
    if pnpm add lodash --quiet &> /dev/null; then
        echo "✅ pnpm package installation works"
    else
        echo "❌ pnpm package installation failed"
    fi
fi

# Test simple Node.js execution
echo "  Testing Node.js execution..."
echo "console.log('Hello from nix-managed Node.js!');" > test.js
if node test.js | grep -q "Hello from nix-managed Node.js!"; then
    echo "✅ Node.js execution works"
else
    echo "❌ Node.js execution failed"
fi

# Cleanup
cd - > /dev/null
rm -rf "$TEST_DIR"

echo
echo "🎉 Node.js setup test complete!"
echo
echo "📚 Usage notes:"
echo "• Primary Node.js: $(which node) (from nix)"
echo "• Use 'fnm use' in projects with .nvmrc for specific versions"
echo "• Use 'pnpm' as primary package manager (fast & efficient)"
echo "• Use 'bun' for ultra-fast operations and modern runtime"
echo "• TypeScript, ESLint, Prettier available globally"
