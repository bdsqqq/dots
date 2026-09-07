{
  schemaVersion = 1;
  id = "dash";
  title = "tailnet services";
  description = "fleet-wide machine and service inventory";
  path = "/";

  tailnet = {
    audience = "owner";
    service = {
      name = "apps";
      port = 443;
    };
  };

  cloudflare = {
    hostname = "dash.igorbedesqui.com";
    audience = "owner";
    connectorTrust = "shared";
    tunnelName = "dash";
    accessName = "owner tailnet services";
  };
}
