# overlays/whisper-cpp-cuda.nix
# Fixes nixpkgs whisper-cpp CUDA support
#
# The problem: nixpkgs sets -DGGML_BACKEND_DL=TRUE which builds backends as 
# loadable modules, but whisper.cpp's #ifdef GGML_BACKEND_DL check never triggers
# because the cmake flag doesn't translate to a C preprocessor define.
# Result: ggml_backend_load_all() is never called, backends=0.
#
# The fix: Disable dynamic backend loading and link CUDA statically.
# This is simpler and more reliable on NixOS.
self: super:
let
  lib = super.lib;
in {
  whisper-cpp = super.whisper-cpp.overrideAttrs (old: {
    # Disable dynamic backend loading - link cuda statically instead
    cmakeFlags = (builtins.filter (f: !(lib.hasPrefix "-DGGML_BACKEND_DL" f) && 
                                       !(lib.hasPrefix "-DGGML_CPU_ALL_VARIANTS" f)) 
                  (old.cmakeFlags or [])) ++ [
      (lib.cmakeBool "GGML_BACKEND_DL" false)
      (lib.cmakeBool "GGML_CPU_ALL_VARIANTS" false)
    ];
  });
}
