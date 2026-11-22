# torch is imported lazily, so the unit tests need only these.
{ pkgs }:
pkgs.runCommand "photo-semantic-benchmark-tests"
{
  nativeBuildInputs = [
    (pkgs.python3.withPackages (python: [ python.numpy python.huggingface-hub ]))
  ];
} ''
  cp ${./benchmark.py} benchmark.py
  cp ${./benchmark.test.py} benchmark.test.py
  python benchmark.test.py
  touch "$out"
''
