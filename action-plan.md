# Migration Plan: Flat to Modular Nix-Darwin Structure

This document provides a step-by-step action plan to migrate a flat Nix flake configuration to a modern, modular structure. This plan is designed to be executed by an agent.

## Overview

The migration is broken down into four stages:

1.  **Directory Scaffolding**: Create the new directory structure.
2.  **Configuration Migration**: Move and split existing Nix files into the new structure.
3.  **Flake Refactoring**: Update `flake.nix` to use the new modular system.
4.  **Verification and Cleanup**: Ensure the new configuration builds and remove old artifacts.

---

### **Stage 1: Directory Scaffolding**

This stage creates the foundational directory tree for the modular setup.

**Instructions:**

1.  Execute the following shell commands from the root of the Nix configuration directory (`/private/etc/nix-darwin`).
2.  Verify that all directories are created successfully.

```bash
# Create Core Directories
mkdir -p modules/darwin modules/home-manager modules/shared overlays hosts

# Create Host Directory (dynamically using the system's hostname)
mkdir -p "hosts/$(hostname)"

# Create Home-Manager Sub-modules
mkdir -p modules/home-manager/shell modules/home-manager/editors modules/home-manager/development modules/home-manager/packages

# Create Placeholder Files for future configuration
touch "hosts/$(hostname)/default.nix"
touch modules/darwin/default.nix
touch modules/home-manager/default.nix
touch modules/home-manager/editors/default.nix
touch modules/home-manager/shell/default.nix
touch modules/home-manager/development/default.nix
touch modules/home-manager/packages/default.nix
touch modules/shared/default.nix
touch overlays/default.nix
```

---

### **Stage 2: Configuration Migration**

This stage involves moving and refactoring the existing configurations into the new, organized structure.

**Instructions:**

1.  Move the specified files to their new locations.
2.  Split `home.nix` into smaller, domain-specific files as described.
3.  Create the necessary `default.nix` files to act as importers for each module.

**Action Steps:**

1.  **Migrate Darwin Configuration**:

    - **Action**: Move `configuration.nix`.
    - **Command**: `mv configuration.nix modules/darwin/default.nix`

2.  **Migrate Neovim Configuration**:

    - **Action**: Move `neovim.nix`.
    - **Command**: `mv neovim.nix modules/home-manager/editors/neovim.nix`
    - **Action**: Populate `modules/home-manager/editors/default.nix` with the following content to import `neovim.nix`:
      ```nix
      # modules/home-manager/editors/default.nix
      {
        imports = [
          ./neovim.nix
          # ./vscode.nix # Placeholder for future VSCode config
        ];
      }
      ```

3.  **Deconstruct `home.nix`**:

    - **Action**: Read the contents of the existing `home.nix`.
    - **Action**: Create new files for each logical domain and copy the relevant sections from `home.nix`.
    - **Example Splits**:
      - `modules/home-manager/shell/zsh.nix`: Should contain `programs.zsh`, `programs.starship`, etc.
      - `modules/home-manager/development/git.nix`: Should contain `programs.git`.
      - `modules/home-manager/packages/cli.nix`: Should contain `home.packages`.
    - **Action**: Populate the corresponding `default.nix` importers. For example:
      ```nix
      # modules/home-manager/shell/default.nix
      { imports = [ ./zsh.nix ]; }
      ```
    - **Action**: Populate `modules/home-manager/default.nix` with top-level settings (`home.username`, `home.homeDirectory`, `home.stateVersion`).

4.  **Assemble the Host Configuration**:

    - **Action**: Populate `hosts/$(hostname)/default.nix` to tie all modules together.

      ```nix
      # hosts/your-hostname/default.nix
      { pkgs, inputs, ... }: {
        imports = [
          # Import all the modular components
          ../../modules/darwin/default.nix
          ../../modules/home-manager/default.nix
        ];

        # Host-specific settings, like networking.hostName, can go here
        # Example:
        # networking.hostName = "your-hostname";
      }
      ```

      _Note: The `home-manager` modules are typically imported via the main `modules/home-manager/default.nix`._

---

### **Stage 3: Flake Refactoring**

This stage simplifies the main `flake.nix` to use the new host-centric configuration.

**Instructions:**

1.  Edit `flake.nix` to replace the long list of modules with a single import.

**Action Steps:**

1.  **Refactor `flake.nix`**:

    - **Locate**: The `darwinConfigurations` section.
    - **Modify**: Change the `modules` attribute to point to the new host configuration file.

    **Before:**

    ```nix
    darwinConfigurations."your-hostname" = nix-darwin.lib.darwinSystem {
      modules = [
        ./configuration.nix
        ./home.nix
        ./neovim.nix
        # ... and other files
      ];
    };
    ```

    **After:**

    ```nix
    darwinConfigurations."your-hostname" = nix-darwin.lib.darwinSystem {
      system = "aarch64-darwin"; # Or "x86_64-darwin"
      specialArgs = { inherit inputs; }; # Pass inputs down to modules
      modules = [
        ./hosts/your-hostname/default.nix
      ];
    };
    ```

---

### **Stage 4: Verification and Cleanup**

This final stage ensures the new configuration is valid and removes legacy files.

**Instructions:**

1.  Run the `darwin-rebuild` command to test the new structure.
2.  Delete the original `home.nix` file after a successful build.

**Action Steps:**

1.  **Build the New Configuration**:

    - **Command**: `darwin-rebuild switch --flake .`
    - **Observe**: Watch for any errors, which will likely be related to incorrect import paths. Debug by verifying all paths in the `default.nix` files.

2.  **Cleanup**:
    - **Action**: After a successful build, remove the original `home.nix`.
    - **Command**: `rm home.nix`

This plan provides a complete, structured path to a more maintainable and scalable Nix configuration.
