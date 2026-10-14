{ ... }:
{
  home-manager.users.bdsqqq = { pkgs, ... }: {
    home.packages = [ (pkgs.wacli or (pkgs.buildGoModule {
      pname = "wacli";
      version = "0.2.0";
      src = pkgs.fetchFromGitHub {
        owner = "steipete";
        repo = "wacli";
        tag = "v0.2.0";
        hash = "sha256-tJ5d33VVW5aYvacHJEVm8cVKVtpdWCIOdHNy2WTR4Cg=";
      };
      vendorHash = "sha256-0mHZjZHQBHTlPzVT4ScyRBSaQ4Z8FEm2GFfsPF6Tjrw=";
      subPackages = [ "cmd/wacli" ];
      # Message search uses SQLite FTS5; upstream enables it in release builds.
      tags = [ "sqlite_fts5" ];
      ldflags = [ "-s" "-w" "-X main.version=0.2.0" ];
      meta.mainProgram = "wacli";
      meta.license = pkgs.lib.licenses.mit;
    })) ];
    # v0.2.0 has flags, not a settings file. Its store is private mutable SQLite
    # state (including device keys and messages), never a tracked config link.
  };
}
