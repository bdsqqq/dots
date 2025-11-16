# r56 desktop fixes

## context
r56 hasn't been actively maintained while mbp-m2 and htz-relay configs were iterated on. multiple issues have accumulated.

## critical issues

### config lost during bundles refactor
- after latest rebuild: themes not working, default wayland wallpaper showing, default statusbar
- r56 wasn't tested during bundles refactor - likely lost significant config
- need to: audit r56 host config, check what bundles are imported, compare to pre-refactor state

### keyboard shortcuts broken after rebuild
- shortcuts for launcher and apps stop responding post-rebuild
- needs investigation: keybind daemon, compositor config, session persistence

### pyprland widgets non-functional
- status bar widgets never worked
- may need config rewrite or replacement

### waybar broken
- unclear if config issue or integration problem
- verify waybar service, config syntax, dependencies

## medium priority

### bluetooth ps5 controller connection fails
- controller never pairs successfully
- check: bluetooth stack, pairing workflow, controller-specific drivers/rules

### login prompt appearance
- described as "super ugly"
- likely display manager theming issue

### slow startup
- system takes too long to boot
- profile systemd boot times, identify bottlenecks

## low priority

### inconsistent wayland animations/styling
- animations and styling "all over the place"
- needs user guidance for desired behavior
- likely stylix/theming conflicts or missing compositor configs

## approach
tackle issues in order, test after each fix, rebuild incrementally.
