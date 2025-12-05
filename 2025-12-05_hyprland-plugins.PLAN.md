# hyprland plugins setup

## goal
add Hyprspace (overview) and hyprscrolling plugins to r56

## approach
use `mkHyprlandPlugin` to build plugins against nixpkgs hyprland (not plugin flakes' pinned versions) - this catches ABI mismatches at build time instead of runtime crashes

## changes
- [x] add plugin sources as non-flake inputs to flake.nix
- [x] create overlay to build plugins with mkHyprlandPlugin  
- [x] add overlay to r56 host config
- [x] register plugins in hyprland.nix via `plugins` attr
- [x] add plugin config/binds
- [x] test build locally (flake check + dry-run passed)
- [ ] deploy to r56

## keybinds added
- `$mod + Tab` - hyprspace overview toggle
- `$mod + [` / `$mod + ]` - hyprscrolling column resize (cycle preset widths)
- `$mod + C` - fit active window
- `$mod + Shift + C` - fit visible windows

## notes
- hyprscrolling is a separate layout, switch to it by setting `general:layout = "scrolling"` in config
- current default remains `dwindle`
