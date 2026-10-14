{ config, pkgs, ... }:
let
  configPath = "${config.my.paths.commonplace}/01_files/nix/modules/yt-dlp/config";
in
{
  imports = [ ../media-cookies/credential.nix ];
  my.mediaCookies.credential.required = true;

  home-manager.users.bdsqqq = { config, ... }: {
    # Empty settings/extraConfig leave this native file as the sole config owner.
    xdg.configFile."yt-dlp/config".source = config.lib.file.mkOutOfStoreSymlink configPath;

    programs.yt-dlp = {
      enable = true;
      # Keep extractor fixes current without upgrading the whole nixpkgs input.
      package = pkgs.yt-dlp.overrideAttrs (old: rec {
        version = "2026.08.19";
        src = pkgs.fetchFromGitHub {
          owner = "yt-dlp";
          repo = "yt-dlp";
          tag = version;
          hash = "sha256-BM5ZeGTmHq+1xH6G/zsuCtjLgYgfRA11ya0zIHK5p4g=";
        };
        meta = old.meta // {
          changelog = "https://github.com/yt-dlp/yt-dlp/blob/${version}/Changelog.md";
        };
      });
    };
  };
}
