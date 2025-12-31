{ pkgs }:

let
  extensionSrc = ./extension;
in
{
  inherit extensionSrc;
}
