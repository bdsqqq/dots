{ ... }:
{
  home-manager.users.bdsqqq.programs.yt-dlp = {
    enable = true;
    settings = { sub-lang = "en.*"; };
  };
}
