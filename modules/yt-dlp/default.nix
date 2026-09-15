{ ... }:
{
  imports = [ ../media-cookies/credential.nix ];
  my.mediaCookies.credential.required = true;

  home-manager.users.bdsqqq.programs.yt-dlp = {
    enable = true;
    settings = { sub-lang = "en.*"; };
  };
}
