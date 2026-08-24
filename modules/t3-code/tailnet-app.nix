{
  schemaVersion = 1;
  id = "t3";
  title = "t3 code";
  description = "remote coding workspace";
  path = "/";

  tailnet = {
    audience = "owner";
    service = {
      name = "t3";
      port = 443;
    };
  };

  cloudflare = {
    hostname = "t3.igorbedesqui.com";
    audience = "owner";
    connectorTrust = "t3";
    tunnelName = "t3";
    accessName = "owner t3 code";
    origin = {
      service = "https://mbp-m2.tail1543a7.ts.net:8443";
      serverName = "mbp-m2.tail1543a7.ts.net";
      policyDestination = "mbp-m2";
      port = 8443;
    };
  };
}
