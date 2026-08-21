{
  schemaVersion = 1;
  id = "files";
  title = "files";
  description = "read-only commonplace file browser";
  path = "/";

  tailnet = {
    audience = "owner";
    service = {
      name = "files";
      port = 443;
    };
  };

  cloudflare = {
    hostname = "files.igorbedesqui.com";
    audience = "owner";
    connectorTrust = "files";
    tunnelName = "files";
    accessName = "owner files";
  };
}
