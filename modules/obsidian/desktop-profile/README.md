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

## web clipper template

The canonical editable template is
[`../01_web_clipping_meta-clipper.json`](../01_web_clipping_meta-clipper.json).
The vault's `_utilities/templates/01_web_clipping_meta-clipper.json` points to
that file via a relative symlink, so there is only one editable export.

Import that template manually into the browser extension after changing it;
the extension stores its own runtime copy and does not watch this file.
each capture creates `index.md` inside a dated, descriptive folder under
`00_inbox`. the desktop profile saves new attachments beside the current note
and generates relative markdown links, so the folder can move as one unit.
these attachment and link defaults apply vault-wide, not only to clips.

clipping still leaves remote media URLs in the note. run **download attachments
for current file** in Obsidian to localize supported images; this is not an
automatic video downloader. existing notes and attachments are not migrated.

`_utilities/obsidian-web-clipper-settings.json` is an archival full-settings
backup, not a template source. It contains older template versions; do not
restore it to update the template. It remains outside Git because full browser
settings may contain private configuration.
