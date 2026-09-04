{
  schemaVersion = 1;
  id = "money";
  title = "company money";
  description = "synthetic read-only company-money capability portal";
  path = "/";

  tailnet = {
    audience = "owner";
    service = {
      name = "money";
      port = 443;
    };
  };

  cloudflare = {
    hostname = "money.igorbedesqui.com";
    audience = "owner";
    connectorTrust = "shared";
    tunnelName = "money";
    accessName = "owner company money";
  };
}
