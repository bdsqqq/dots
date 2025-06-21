#!/usr/bin/env bash
set -euo pipefail

# VM runner script with sensible defaults
# Usage: ./run-vm.sh [build|run|clean]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VM_NAME="nixos-vm"

# Default QEMU options for good VM experience
DEFAULT_QEMU_OPTS=(
    "-m" "8192"                    # 8GB RAM
    "-smp" "4"                     # 4 CPU cores
    "-enable-kvm"                  # Hardware acceleration
    "-vga" "virtio"                # Better graphics
    "-display" "gtk,gl=on"         # GTK display with OpenGL
    "-netdev" "user,id=net0,hostfwd=tcp::2222-:22"  # SSH port forwarding
    "-device" "virtio-net,netdev=net0"
    "-device" "virtio-balloon"     # Memory ballooning
    "-device" "virtio-rng-pci"     # Hardware RNG
)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_requirements() {
    if ! command -v nix &> /dev/null; then
        log_error "Nix is required but not found in PATH"
        exit 1
    fi
    
    if ! command -v qemu-system-x86_64 &> /dev/null; then
        log_warn "QEMU not found, VM might not run properly"
    fi
    
    # Check if KVM is available
    if [[ ! -r /dev/kvm ]]; then
        log_warn "KVM not available, VM will be slower"
        # Remove KVM from default options
        DEFAULT_QEMU_OPTS=("${DEFAULT_QEMU_OPTS[@]//-enable-kvm}")
    fi
}

build_vm() {
    log_info "Building NixOS VM configuration..."
    cd "$SCRIPT_DIR"
    
    if nix build ".#nixosConfigurations.${VM_NAME}.config.system.build.vm"; then
        log_info "VM built successfully at: ./result/bin/run-${VM_NAME}-vm"
    else
        log_error "Failed to build VM"
        exit 1
    fi
}

run_vm() {
    local vm_script="./result/bin/run-${VM_NAME}-vm"
    
    if [[ ! -x "$vm_script" ]]; then
        log_warn "VM not built, building first..."
        build_vm
    fi
    
    log_info "Starting VM with options: ${DEFAULT_QEMU_OPTS[*]}"
    log_info "SSH access: ssh -p 2222 bdsqqq@localhost"
    log_info "Press Ctrl+Alt+G to release mouse capture"
    
    # Combine default options with any user-provided options
    local qemu_opts=("${DEFAULT_QEMU_OPTS[@]}")
    if [[ -n "${QEMU_OPTS:-}" ]]; then
        read -ra user_opts <<< "$QEMU_OPTS"
        qemu_opts+=("${user_opts[@]}")
    fi
    
    # Export QEMU_OPTS for the VM script
    export QEMU_OPTS="${qemu_opts[*]}"
    
    exec "$vm_script"
}

clean_vm() {
    log_info "Cleaning VM build artifacts..."
    rm -rf result
    nix-collect-garbage -d
    log_info "Cleanup complete"
}

print_help() {
    cat << EOF
NixOS VM Runner

Usage: $0 [COMMAND]

Commands:
    build       Build the VM (default if no command given)
    run         Build and run the VM
    clean       Clean build artifacts
    help        Show this help

Environment Variables:
    QEMU_OPTS   Additional QEMU options (e.g., "QEMU_OPTS='-m 12288'")

Examples:
    $0 run                           # Build and run with defaults
    QEMU_OPTS="-m 12288" $0 run     # Run with 12GB RAM
    $0 build                        # Just build, don't run
    $0 clean                        # Clean up

Default VM Configuration:
    - 8GB RAM (-m 8192)
    - 4 CPU cores (-smp 4)  
    - KVM acceleration (if available)
    - VirtIO graphics with OpenGL
    - SSH forwarded to port 2222

EOF
}

main() {
    local command="${1:-build}"
    
    case "$command" in
        "build")
            check_requirements
            build_vm
            ;;
        "run")
            check_requirements
            run_vm
            ;;
        "clean")
            clean_vm
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
