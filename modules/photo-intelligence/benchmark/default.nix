{ pkgs }:

let
  python = pkgs.python3.withPackages (packages: [
    packages.huggingface-hub
    packages.numpy
    packages.pillow
    packages.pillow-heif
    packages.torch
    packages.transformers
  ]);
in
pkgs.writeShellApplication {
  name = "photo-semantic-benchmark";
  runtimeInputs = [ python ];
  text = ''
    export PYTHONNOUSERSITE=1
    export TOKENIZERS_PARALLELISM=false
    exec python ${./benchmark.py} \
      --worker ${../workers/hf-worker.py} \
      "$@"
  '';
}
