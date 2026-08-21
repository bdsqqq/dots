{
  schemaVersion = 1;
  id = "photos";
  title = "family photos";
  description = "read-only household photo gallery";
  path = "/gallery/";

  tailnet = {
    audience = "family";
    service = {
      name = "photos";
      port = 443;
    };
  };

  cloudflare = {
    hostname = "fotos.igorbedesqui.com";
    audience = "family";
    connectorTrust = "shared";
    tunnelName = "photos";
    accessName = "family photos";
  };
}
