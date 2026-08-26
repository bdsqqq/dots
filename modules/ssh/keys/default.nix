{ lib }: {
  # personal device keys
  personalKeys = [ (lib.trim (builtins.readFile ./mbp-m2.pub)) ];

  # Shortcuts can only open the display portal. The generated iPad key cannot
  # request a shell, PTY, forwarding, or a different command.
  openDisplayPortalKeys = [
    ''restrict,command="/etc/profiles/per-user/bdsqqq/bin/open-display connect" ${lib.trim (builtins.readFile ./ipad-shortcuts.pub)}''
  ];
}
