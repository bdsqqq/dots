{
  schemaVersion = 1;
  id = "hue";
  title = "hue";
  description = "nearby Hue bulb control";
  path = "/";

  tailnet = {
    audience = "owner";
    service = {
      name = "hue";
      port = 443;
    };
  };

  cloudflare = null;
}
