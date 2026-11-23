{ pkgs }:
pkgs.runCommand "agents-research-acquire-tests"
{
  nativeBuildInputs = [ pkgs.python3 ];
} ''
  cp ${./acquire.py} acquire.py
  cp ${./test_acquire.py} test_acquire.py
  python -m unittest -v test_acquire
  touch "$out"
''
