{ flexget, python3Packages }:

# The pinned wheel requires cryptography, but nixpkgs omits it and fails its runtime-dependency check.
flexget.overridePythonAttrs (old: {
  dependencies = (old.dependencies or [ ]) ++ [ python3Packages.cryptography ];
})
