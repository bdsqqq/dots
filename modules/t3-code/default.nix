{ hostSystem, lib, ... }:
let
  app = import ./tailnet-app.nix;
in
{
  my.tailnetRegistry.services.t3-code = {
    inherit (app) title description;
    inherit (app.tailnet) audience;
    port = if lib.hasSuffix "-darwin" hostSystem then app.cloudflare.origin.port else app.tailnet.service.port;
    target = "http://127.0.0.1:3773";
    scheme = "https";
    healthPath = "/.well-known/t3/environment";
    adoptExisting = true;
  };
}
