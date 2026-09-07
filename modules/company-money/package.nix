{ fetchPnpmDeps
, esbuild
, lib
, makeWrapper
, nodejs
, pnpm_10
, pnpmConfigHook
, stdenvNoCC
,
}:

let
  pnpm = pnpm_10;
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "company-money";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./pnpm-lock.yaml
      ./pnpm-workspace.yaml
      ./portal/portal-server.mjs
      ./portal/index.html
      ./portal/portal.css
      ./portal/portal.js
      (lib.fileset.fileFilter (file: lib.hasSuffix ".ts" file.name) ./.)
    ];
  };

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    inherit pnpm;
    fetcherVersion = 3;
    pnpmInstallFlags = [ "--prod" ];
    hash = "sha256-zH5oMwOjfc7NJYrru1XE8zhMyNBvyg8rL5nqB8C1238=";
  };
  pnpmInstallFlags = [ "--prod" ];

  nativeBuildInputs = [
    esbuild
    makeWrapper
    nodejs
    pnpm
    pnpmConfigHook
  ];

  buildPhase = ''
    runHook preBuild

    esbuild company-money-bin.ts \
      --bundle \
      --format=esm \
      --outfile=company-money.mjs \
      --platform=node \
      --target=node22

    esbuild portal/portal-server.mjs --bundle --format=esm --outfile=portal-server.mjs --platform=node --target=node22

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm644 company-money.mjs "$out/lib/company-money/company-money.mjs"
    makeWrapper ${lib.getExe nodejs} "$out/bin/company-money" \
      --add-flags "$out/lib/company-money/company-money.mjs"

    install -Dm644 portal-server.mjs "$out/lib/company-money/portal-server.mjs"
    cp portal/index.html portal/portal.css portal/portal.js "$out/lib/company-money/"
    makeWrapper ${lib.getExe nodejs} "$out/bin/company-money-portal" \
      --add-flags "$out/lib/company-money/portal-server.mjs --html $out/lib/company-money/index.html --css $out/lib/company-money/portal.css --js $out/lib/company-money/portal.js"

    runHook postInstall
  '';

  meta = {
    description = "Private local company-money evidence ledger";
    license = lib.licenses.mit;
    mainProgram = "company-money";
    platforms = lib.platforms.darwin ++ lib.platforms.linux;
  };
})
