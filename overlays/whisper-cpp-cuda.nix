# overlays/whisper-cpp-cuda.nix
# Fixes nixpkgs whisper-cpp to properly install CUDA backend when cudaSupport=true
# See: https://github.com/ggml-org/whisper.cpp/pull/3195
self: super:
let
  lib = super.lib;
in {
  whisper-cpp = super.whisper-cpp.overrideAttrs (old: {
    # Tell ggml where to find backend .so files at runtime
    cmakeFlags = (old.cmakeFlags or []) ++ [
      (lib.cmakeFeature "GGML_BACKEND_DIR" "${placeholder "out"}/lib/ggml")
    ];

    # Install backend shared objects that cmake builds but doesn't install
    postInstall = (old.postInstall or "") + ''
      # Find and install ggml backend modules from the build tree
      backends=$(find . -name 'libggml-*.so' -type f 2>/dev/null || true)

      if [ -n "$backends" ]; then
        echo "Installing ggml backends:"
        mkdir -p "$out/lib/ggml"
        for so in $backends; do
          echo "  $so -> $out/lib/ggml/"
          cp -v "$so" "$out/lib/ggml/"
        done
      else
        echo "No ggml backend modules found"
      fi
    '';
  });
}
