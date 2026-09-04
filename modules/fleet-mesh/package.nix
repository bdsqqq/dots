{
  fetchPnpmDeps,
  esbuild,
  lib,
  makeWrapper,
  nodejs,
  pnpm_10,
  pnpmConfigHook,
  stdenvNoCC,
}:

let
  pnpm = pnpm_10;
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "fleet-mesh-daemon";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./pnpm-lock.yaml
      ./pnpm-workspace.yaml
      (lib.fileset.fileFilter (file: lib.hasSuffix ".ts" file.name) ./.)
    ];
  };

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    inherit pnpm;
    fetcherVersion = 3;
    pnpmInstallFlags = [ "--prod" ];
    hash = "sha256-ZWaO3eI6m4hnsSEqdthSOEO4TgwKmq2zSLwzxytYVnQ=";
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

    esbuild fleet-daemon-bin.ts \
      --bundle \
      --format=esm \
      --outfile=fleet-daemon.mjs \
      --platform=node \
      --target=node22
    esbuild fleet-bin.ts \
      --bundle \
      --format=esm \
      --outfile=fleet.mjs \
      --platform=node \
      --target=node22 \
      --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm644 fleet-daemon.mjs "$out/lib/fleet-mesh/fleet-daemon.mjs"
    install -Dm644 fleet.mjs "$out/lib/fleet-mesh/fleet.mjs"
    makeWrapper ${lib.getExe nodejs} "$out/bin/fleet-daemon" \
      --add-flags "$out/lib/fleet-mesh/fleet-daemon.mjs"
    makeWrapper ${lib.getExe nodejs} "$out/bin/fleet" \
      --add-flags "$out/lib/fleet-mesh/fleet.mjs"

    runHook postInstall
  '';

  meta = {
    description = "Supervised local fleet mesh daemon";
    license = lib.licenses.mit;
    mainProgram = "fleet-daemon";
    platforms = lib.platforms.darwin;
  };
})
