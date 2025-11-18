{ lib }:
{
  # personal device keys
  personalKeys = [
    (lib.removeSuffix "\n" (builtins.readFile ./mbp-m2.pub))
  ];
}
