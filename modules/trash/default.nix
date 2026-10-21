{ lib, pkgs, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;

  # Use native macOS Trash rather than trash-cli's parallel freedesktop store.
  # The system CLI avoids Finder automation permission prompts and hangs.
  trashDarwin = pkgs.runCommand "trash-darwin" { } ''
    mkdir -p "$out/bin"

    cat > "$out/bin/trash" <<'EOF'
    #!/usr/bin/env bash
    exec /usr/bin/trash "$@"
    EOF

    cat > "$out/bin/trash-empty" <<'EOF'
    #!/usr/bin/env bash
    set -euo pipefail
    /usr/bin/osascript <<'APPLESCRIPT'
    tell application "Finder" to empty trash
    APPLESCRIPT
    EOF

    cat > "$out/bin/trash-list" <<'EOF'
    #!/usr/bin/env bash
    set -euo pipefail
    /usr/bin/osascript <<'APPLESCRIPT'
    set trashPaths to {}
    tell application "Finder"
      repeat with trashItem in items of trash
        set end of trashPaths to POSIX path of (trashItem as alias)
      end repeat
    end tell
    set AppleScript's text item delimiters to linefeed
    trashPaths as text
    APPLESCRIPT
    EOF

    cat > "$out/bin/trash-restore" <<'EOF'
    #!/usr/bin/env bash
    set -euo pipefail
    echo "trash-restore: opening Finder Trash; select item(s), then use File > Put Back (⌘⌫)." >&2
    /usr/bin/osascript <<'APPLESCRIPT'
    tell application "Finder"
      open trash
      activate
    end tell
    APPLESCRIPT
    EOF

    cat > "$out/bin/trash-rm" <<'EOF'
    #!/usr/bin/env bash
    set -euo pipefail
    echo "trash-rm: unsupported for native macOS Trash; use trash-empty or Finder's Delete Immediately." >&2
    exit 69
    EOF

    chmod +x "$out/bin"/trash "$out/bin"/trash-empty "$out/bin"/trash-list "$out/bin"/trash-restore "$out/bin"/trash-rm
    ln -s trash "$out/bin/trash-put"
  '';
in {
  home-manager.users.bdsqqq = {
    home.packages = [ (if isDarwin then trashDarwin else pkgs.trash-cli) ];
  };
}
