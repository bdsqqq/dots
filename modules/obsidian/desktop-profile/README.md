# Obsidian desktop profile

This directory is the shared mutable desktop configuration for the
`commonplace` vault. Obsidian writes to it through the vault-level
`.obsidian-desktop` symlink, so normal settings and plugin updates appear as
working-tree changes.

On each desktop, set **Settings → Files and links → Override config folder** to
`.obsidian-desktop`.

On iPhone and iPad, use `.obsidian-mobile`. That profile remains a real
directory inside the vault so mobile clients never need to resolve a desktop
symlink.

The original `.obsidian` directory and its Syncthing conflict copies are legacy
evidence. The activation intentionally does not modify or delete them.
