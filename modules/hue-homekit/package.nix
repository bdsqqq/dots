{
  lib,
  stdenvNoCC,
  nodejs,
  esbuild,
  pnpm_10,
  fetchPnpmDeps,
  pnpmConfigHook,
  makeWrapper,
}:
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "hue-homekit";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./pnpm-lock.yaml
      ./pnpm-workspace.yaml
      ./main.ts
      ./light.ts
    ];
  };
  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_10;
    fetcherVersion = 3;
    pnpmInstallFlags = [ "--prod" ];
    hash = "sha256-HNG+2Bc3trvErHQpBvntEzSrD/+4So9ysIwzWT4sSLk=";
  };
  pnpmInstallFlags = [ "--prod" ];
  nativeBuildInputs = [
    nodejs
    esbuild
    pnpm_10
    pnpmConfigHook
    makeWrapper
  ];
  buildPhase = ''
    esbuild main.ts --bundle --packages=external --format=esm --platform=node --target=node24 --outfile=main.mjs
  '';
  installPhase = ''
    app="$out/Applications/Hue HomeKit.app"
    mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
    install -m755 ${lib.getExe nodejs} "$app/Contents/MacOS/HueHomeKit"
    cp main.mjs "$app/Contents/Resources/"
    cp -R node_modules "$app/Contents/Resources/"
    cat > "$app/Contents/Info.plist" <<'PLIST'
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0"><dict>
      <key>CFBundleIdentifier</key><string>dev.bdsqqq.hue-homekit</string>
      <key>CFBundleExecutable</key><string>HueHomeKit</string>
      <key>CFBundleName</key><string>Hue HomeKit</string>
      <key>CFBundleDisplayName</key><string>Hue HomeKit</string>
      <key>CFBundlePackageType</key><string>APPL</string>
      <key>CFBundleVersion</key><string>1</string>
      <key>LSUIElement</key><true/>
      <key>NSLocalNetworkUsageDescription</key><string>Let Apple Home discover and control your desk lamp on the home network.</string>
      <key>NSBonjourServices</key><array><string>_hap._tcp</string></array>
    </dict></plist>
    PLIST
    /usr/bin/codesign --force --deep --sign - "$app"
    makeWrapper "$app/Contents/MacOS/HueHomeKit" "$out/bin/hue-homekit" --add-flags "\"$app/Contents/Resources/main.mjs\""
  '';
  dontFixup = true;
  meta.platforms = lib.platforms.darwin;
})
