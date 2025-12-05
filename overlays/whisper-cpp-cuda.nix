# overlays/whisper-cpp-cuda.nix
# Fixes nixpkgs whisper-cpp to properly install CUDA backend when cudaSupport=true
# 
# ggml with GGML_BACKEND_DL=true looks for backends in:
# 1. GGML_BACKEND_DIR (compile-time)
# 2. executable directory (where whisper-cli lives)
# 3. current working directory
#
# We install backends to bin/ so they're found next to the executable.
self: super:
let
  lib = super.lib;
in {
  whisper-cpp = super.whisper-cpp.overrideAttrs (old: {
    nativeBuildInputs = (old.nativeBuildInputs or []) ++ [ self.patchelf ];

    # Install backend shared objects to bin/ where ggml looks for them
    postInstall = (old.postInstall or "") + ''
      # Find and install ggml backend modules from the build tree
      backends=$(find . -name 'libggml-*.so' -type f 2>/dev/null || true)

      if [ -n "$backends" ]; then
        echo "Installing ggml backends to bin/:"
        for so in $backends; do
          echo "  $so -> $out/bin/"
          cp -v "$so" "$out/bin/"
        done

        # Fix RPATH to remove /build/ references
        for so in "$out/bin"/libggml-*.so; do
          echo "Fixing RPATH for $so"
          patchelf --set-rpath "$out/lib" "$so" || true
        done
      else
        echo "No ggml backend modules found"
      fi
    '';
  });
}
