{ pkgs }:
let
  payload = pkgs.callPackage ./package.nix { nodejs = pkgs.nodejs_latest; };
  upgrade = pkgs.callPackage ./package.nix { nodejs = pkgs.nodejs_24; };
  source = pkgs.lib.fileset.toSource {
    root = ../..;
    fileset = pkgs.lib.fileset.unions [
      (pkgs.lib.fileset.fileFilter (file: pkgs.lib.hasSuffix ".ts" file.name) ./.)
      ../service-events/events.ts
    ];
  };
in
pkgs.runCommand "hue-permission-identity-tests" {
  nativeBuildInputs = [ pkgs.nodejs_latest pkgs.openssl pkgs.rcodesign ];
  __darwinAllowLocalNetworking = true;
} ''
  cp -R ${source}/. source
  chmod -R u+w source
  cd source
  ln -s ${pkgs.lib.escapeShellArg "${payload}/Applications/Hue Control.app/Contents/Resources/node_modules"} modules/hue-control/node_modules
  # These are disposable fixture identities, never the host's signing key or TCC.
  export HUE_SIGNER=${pkgs.lib.getExe pkgs.rcodesign}
  export HUE_OPENSSL=${pkgs.lib.getExe pkgs.openssl}
  export HUE_APP_PAYLOAD=${pkgs.lib.escapeShellArg "${payload}/Applications/Hue Control.app"}
  export HUE_UPGRADE_PAYLOAD=${pkgs.lib.escapeShellArg "${upgrade}/Applications/Hue Control.app"}
  node --experimental-strip-types --test modules/hue-control/*.test.ts
  touch "$out"
''
