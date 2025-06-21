# Foundation Documentation

## Multi-System Foundation Enhancements

This document outlines the enhancements made to create a robust, scalable foundation for nix configurations.

### 1. Enhanced specialArgs Handling

**Problem**: Simple `specialArgs = { inherit inputs; }` doesn't provide enough context for complex, multi-system configurations.

**Solution**: Enhanced specialArgs with:
- All inputs passed through
- System architecture information for conditional logic
- Helper functions for cross-platform package management
- Consistent argument passing to all modules

```nix
specialArgs = { 
  inherit inputs;
  # Make system architecture available for conditional logic
  inherit (inputs.nixpkgs.lib) systems;
  # Helper function to get packages for different systems
  pkgsFor = system: import inputs.nixpkgs {
    inherit system; 
    config.allowUnfree = true;
  };
};
```

### 2. Development Shell Infrastructure

**Added**: Comprehensive development shell with:
- Nix development tools (nixpkgs-fmt, nil, statix, deadnix)
- System administration tools (cachix, direnv)
- Platform-specific tools (darwin-rebuild for macOS)
- Helpful shell hook with tool documentation

**Usage**: 
```bash
nix develop          # Enter development shell
nix fmt              # Format nix files
```

### 3. Multi-System Scalability

**Prepared for**: Easy expansion to additional systems:
- Intel Macs (x86_64-darwin)
- Linux servers (x86_64-linux, aarch64-linux)
- Consistent configuration patterns across platforms

**Benefits**:
- Shared modules work across all systems
- Consistent input handling
- Platform-specific conditional logic support

### 4. Module Argument Consistency

**Enhancement**: Ensured all modules receive consistent arguments:
```nix
modules = [
  ./hosts/mbp14.local/default.nix
  {
    # Ensure all modules receive enhanced specialArgs
    _module.args = { inherit inputs; };
  }
];
```

**For home-manager**:
```nix
extraSpecialArgs = { 
  inherit inputs systems pkgsFor;
};
```

### 5. Testing Infrastructure

**Verification Commands**:
- `nix flake check` - Validates entire flake configuration
- `nix develop --command echo "test"` - Tests development shell
- `nix fmt` - Formats code using nixpkgs-fmt

### 6. Future Scalability

**Ready for**:
- Additional Darwin hosts (just add to darwinConfigurations)
- NixOS configurations (commented examples provided)
- Cross-platform shared modules
- Complex multi-system deployments

### 7. Best Practices Implemented

1. **Consistent Input Handling**: All modules receive the same enhanced arguments
2. **System-Aware Configuration**: Conditional logic based on system architecture
3. **Development Tooling**: Comprehensive developer experience
4. **Scalable Structure**: Easy to add new systems and hosts
5. **Documentation**: Clear comments explaining the enhanced structure

## Testing the Foundation

```bash
# Verify flake structure
nix flake check

# Test development environment
nix develop

# Format code
nix fmt

# Build system (when ready)
darwin-rebuild build --flake .#mbp14
```

## Next Steps

With this foundation in place, you can now:
1. Add new Darwin hosts by extending `darwinConfigurations`
2. Add NixOS configurations by uncommenting and extending `nixosConfigurations`
3. Create shared modules that work across all systems
4. Implement complex multi-system deployments
5. Use the development shell for consistent nix tooling

The foundation is designed to scale from a single machine to a complex multi-system environment while maintaining consistency and ease of use.
