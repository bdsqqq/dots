#!/usr/bin/env bash
set -euo pipefail

# Smoke test script for NixOS VM configuration
# This runs basic validation without requiring a full VM boot

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_test() {
    echo -e "${BLUE}[TEST]${NC} $1"
}

test_flake_syntax() {
    log_test "Testing flake syntax..."
    cd "$SCRIPT_DIR"
    
    if nix flake show --json > /dev/null 2>&1; then
        log_info "✓ Flake syntax is valid"
    else
        log_error "✗ Flake syntax error"
        return 1
    fi
}

test_configuration_evaluation() {
    log_test "Testing configuration evaluation..."
    cd "$SCRIPT_DIR"
    
    # Test if the system configuration can be evaluated
    if nix eval ".#nixosConfigurations.nixos-vm.config.system.name" --raw > /dev/null 2>&1; then
        log_info "✓ Configuration evaluates successfully"
    else
        log_error "✗ Configuration evaluation failed"
        return 1
    fi
}

test_vm_build() {
    log_test "Testing VM build (dry-run)..."
    cd "$SCRIPT_DIR"
    
    if nix build ".#nixosConfigurations.nixos-vm.config.system.build.vm" --dry-run 2>/dev/null; then
        log_info "✓ VM build plan is valid"
    else
        log_error "✗ VM build plan failed"
        return 1
    fi
}

test_essential_packages() {
    log_test "Testing essential packages are included..."
    cd "$SCRIPT_DIR"
    
    # Check if niri is in the configuration
    if nix eval ".#nixosConfigurations.nixos-vm.config.programs.niri.enable" --raw 2>/dev/null | grep -q "true"; then
        log_info "✓ Niri window manager is enabled"
    else
        log_warn "⚠ Niri might not be properly configured"
    fi
    
    # Check if essential programs are available
    local essential_programs=("git" "neovim" "firefox")
    for program in "${essential_programs[@]}"; do
        if nix eval ".#nixosConfigurations.nixos-vm.config.environment.systemPackages" --json 2>/dev/null | grep -q "$program"; then
            log_info "✓ $program is available"
        else
            log_warn "⚠ $program might not be available"
        fi
    done
}

test_user_configuration() {
    log_test "Testing user configuration..."
    cd "$SCRIPT_DIR"
    
    # Check if user exists
    if nix eval ".#nixosConfigurations.nixos-vm.config.users.users.bdsqqq.name" --raw 2>/dev/null | grep -q "bdsqqq"; then
        log_info "✓ User 'bdsqqq' is configured"
    else
        log_error "✗ User 'bdsqqq' not found"
        return 1
    fi
}

test_hardware_configuration() {
    log_test "Testing hardware configuration..."
    cd "$SCRIPT_DIR"
    
    # Check if hardware configuration is valid
    if [[ -f "hardware.nix" ]]; then
        log_info "✓ Hardware configuration file exists"
    else
        log_warn "⚠ Hardware configuration file missing"
    fi
}

run_all_tests() {
    log_info "Running NixOS VM smoke tests..."
    echo
    
    local failed_tests=0
    
    test_flake_syntax || ((failed_tests++))
    test_configuration_evaluation || ((failed_tests++))
    test_vm_build || ((failed_tests++))
    test_essential_packages || ((failed_tests++))
    test_user_configuration || ((failed_tests++))
    test_hardware_configuration || ((failed_tests++))
    
    echo
    if ((failed_tests == 0)); then
        log_info "All tests passed! VM configuration looks good."
        return 0
    else
        log_error "$failed_tests test(s) failed. Check configuration."
        return 1
    fi
}

print_help() {
    cat << EOF
NixOS VM Smoke Test

Usage: $0 [COMMAND]

Commands:
    all         Run all smoke tests (default)
    syntax      Test flake syntax only
    eval        Test configuration evaluation
    build       Test VM build (dry-run)
    packages    Test essential packages
    user        Test user configuration
    hardware    Test hardware configuration
    help        Show this help

EOF
}

main() {
    local command="${1:-all}"
    
    case "$command" in
        "all")
            run_all_tests
            ;;
        "syntax")
            test_flake_syntax
            ;;
        "eval")
            test_configuration_evaluation
            ;;
        "build")
            test_vm_build
            ;;
        "packages")
            test_essential_packages
            ;;
        "user")
            test_user_configuration
            ;;
        "hardware")
            test_hardware_configuration
            ;;
        "help"|"-h"|"--help")
            print_help
            ;;
        *)
            log_error "Unknown command: $command"
            print_help
            exit 1
            ;;
    esac
}

main "$@"
