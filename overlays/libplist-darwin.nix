final: prev: {
  libplist = prev.libplist.overrideAttrs (old: {
    # libplist 2.7.0's XML/parser tests segfault on Darwin 25 arm64.
    # Keep checks enabled elsewhere; this overlay is a local unblock for
    # libimobiledevice/ifuse until nixpkgs or upstream carries a narrower fix.
    doCheck = !prev.stdenv.isDarwin;
  });
}
