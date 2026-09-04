{
  esbuild,
  fetchPnpmDeps,
  lib,
  nodejs,
  pnpm_10,
  pnpmConfigHook,
  runtimeShell,
  stdenvNoCC,
}:

let
  pnpm = pnpm_10;
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "hue-control";
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
    hash = "sha256-fKUReIvuN4AttR/F8zQ9hZkyzlluwqZ4khcigzU+aCs=";
  };
  pnpmInstallFlags = [ "--prod" ];

  nativeBuildInputs = [
    esbuild
    nodejs
    pnpm
    pnpmConfigHook
  ];

  buildPhase = ''
    runHook preBuild

    esbuild hue-control-main.ts \
      --bundle \
      --external:webbluetooth \
      --format=esm \
      --outfile=hue-control.mjs \
      --platform=node \
      --target=node24

    esbuild hue-cli.ts \
      --bundle \
      --format=esm \
      --outfile=hue-cli.mjs \
      --platform=node \
      --target=node24

    ${lib.getExe nodejs} -e "import('webbluetooth')"

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    app="$out/Applications/Hue Control.app"
    mkdir -p "$out/bin" "$app/Contents/MacOS" "$app/Contents/Resources"
    install -m755 ${lib.getExe nodejs} "$app/Contents/MacOS/HueControl"
    install -m644 hue-control.mjs "$app/Contents/Resources/hue-control.mjs"
    install -m644 hue-cli.mjs "$app/Contents/Resources/hue-cli.mjs"
    cp -R node_modules "$app/Contents/Resources/node_modules"

    cat > "$out/bin/hue" <<EOF
    #!${runtimeShell}
    exec "$app/Contents/MacOS/HueControl" "$app/Contents/Resources/hue-cli.mjs" "\$@"
    EOF
    chmod 755 "$out/bin/hue"

    cat > "$app/Contents/Info.plist" <<'PLIST'
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
      <key>CFBundleDisplayName</key>
      <string>Hue Control</string>
      <key>CFBundleExecutable</key>
      <string>HueControl</string>
      <key>CFBundleIdentifier</key>
      <string>dev.bdsqqq.hue-control</string>
      <key>CFBundleInfoDictionaryVersion</key>
      <string>6.0</string>
      <key>CFBundleName</key>
      <string>Hue Control</string>
      <key>CFBundlePackageType</key>
      <string>APPL</string>
      <key>CFBundleShortVersionString</key>
      <string>${finalAttrs.version}</string>
      <key>CFBundleVersion</key>
      <string>1</string>
      <key>LSUIElement</key>
      <true/>
      <key>NSBluetoothAlwaysUsageDescription</key>
      <string>Control the nearby Philips Hue bulb selected by this user.</string>
      <key>NSBluetoothPeripheralUsageDescription</key>
      <string>Control the nearby Philips Hue bulb selected by this user.</string>
    </dict>
    </plist>
    PLIST

    /usr/bin/codesign --force --deep --sign - "$app"

    runHook postInstall
  '';

  dontFixup = true;

  meta = {
    description = "Tailnet-only control service for a nearby Hue bulb";
    license = lib.licenses.mit;
    platforms = lib.platforms.darwin;
  };
})
