{
  schemaVersion = 1;
  id = "html-stuff";
  title = "html stuff";
  description = "generated documents and visual artifacts";
  path = "/";

  tailnet = {
    audience = "owner";
    service = {
      name = "html-stuff";
      port = 443;
    };
  };

  cloudflare = {
    hostname = "stuff.igorbedesqui.com";
    audience = "family";
    connectorTrust = "shared";
  };
}
