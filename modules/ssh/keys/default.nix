{ lib }: {
  # personal device keys
  personalKeys = [ (lib.trim (builtins.readFile ./mbp-m2.pub)) ];

  # Shortcuts can only open the display portal. The device keys cannot
  # request a shell, PTY, forwarding, or a different command.
  openDisplayPortalKeys = [
    ''restrict,command="/Users/bdsqqq/.local/bin/open-display-portal connect" ${lib.trim (builtins.readFile ./ipad-shortcuts.pub)}''
    ''restrict,command="/Users/bdsqqq/.local/bin/open-display-portal connect" ${lib.trim (builtins.readFile ./iph16-shortcuts.pub)}''
  ];
}
