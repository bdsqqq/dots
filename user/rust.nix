{ ... }:
{
  home-manager.users.bdsqqq = { pkgs, lib, ... }: {
    home.packages = with pkgs; [
      rustup           # manages toolchains (stable/nightly), includes rustc, cargo, rustfmt, clippy, rust-analyzer
      cargo-nextest    # modern test runner (faster, better output than cargo test)
      cargo-watch      # file watcher — re-runs check/test/build on save
      cargo-audit      # security: scan deps against RustSec advisory DB
      cargo-deny       # lint deps for licenses, bans, advisories, sources
      cargo-expand     # show macro expansion output
      cargo-flamegraph # generate flamegraphs from cargo bench/run
      cargo-outdated   # check for outdated deps
      cargo-bloat      # find what takes space in your binary
    ];

    home.activation.ensureRustToolchain = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      if ! "${pkgs.rustup}/bin/rustup" show active-toolchain >/dev/null 2>&1; then
        "${pkgs.rustup}/bin/rustup" default stable
      fi
    '';
  };
}
