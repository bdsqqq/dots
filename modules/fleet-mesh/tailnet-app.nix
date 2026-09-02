{
  schemaVersion = 1;
  id = "fleet-mesh";
  title = "fleet mesh";
  description = "encrypted fleet command relay";
  path = "/";

  tailnet = {
    audience = "owner";
    service = {
      name = "fleet-mesh";
      port = 443;
    };
  };

  cloudflare = null;
}
