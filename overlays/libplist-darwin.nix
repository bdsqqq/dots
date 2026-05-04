final: prev: {
  libplist = prev.libplist.overrideAttrs (old: {
    doCheck = false;
  });
}
