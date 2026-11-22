# opentelemetry-collector-contrib, used by modules/o11y. hosts and flake checks
# share this overlay so a check never builds a different collector than hosts run.
final: prev: {
  # the upstream release build, not nixpkgs': hydra hasn't cached a working
  # 0.155.0 on Go 1.27, and compiling it ran small hosts out of memory and disk.
  # upstream's release already excludes the ASAP extension that panics at start.
  opentelemetry-collector-contrib =
    let
      version = "0.155.0";
      platform = {
        x86_64-linux = { name = "linux_amd64"; hash = "sha256-Ipz93rBiHSoBG/0ciJQzVHnkY0m5Ogz7zL5lNEOj7JU="; };
        aarch64-linux = { name = "linux_arm64"; hash = "sha256-8vrAedW3Yacp5Jul2zGcq5Kv/FWEBtxC48HAjggn4U8="; };
        aarch64-darwin = { name = "darwin_arm64"; hash = "sha256-3J7NUkO8YyopAdAov8enBftjF7JpyVFLX4GHuAyvjFY="; };
      }.${final.stdenv.hostPlatform.system};
    in
    final.stdenvNoCC.mkDerivation {
      pname = "otelcol-contrib";
      inherit version;
      src = final.fetchurl {
        url = "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${version}/otelcol-contrib_${version}_${platform.name}.tar.gz";
        inherit (platform) hash;
      };
      sourceRoot = ".";
      dontConfigure = true;
      dontBuild = true;
      # a static go binary; patching or stripping would only break it.
      dontFixup = true;
      installPhase = "install -Dm755 otelcol-contrib $out/bin/otelcol-contrib";
      meta = {
        mainProgram = "otelcol-contrib";
        license = final.lib.licenses.asl20;
        sourceProvenance = [ final.lib.sourceTypes.binaryNativeCode ];
      };
    };
}
