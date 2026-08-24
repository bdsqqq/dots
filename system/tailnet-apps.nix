{ lib, root }:

let
  discover = directory:
    lib.concatMap
      (name:
        let
          path = directory + "/${name}";
          type = (builtins.readDir directory).${name};
        in
        if type == "directory" then
          discover path
        else if type == "regular" && name == "tailnet-app.nix" then
          [ path ]
        else
          [ ])
      (builtins.attrNames (builtins.readDir directory));
  declarationPaths = discover (root + "/modules") ++ discover (root + "/user");
  declarations = map
    (path: {
      source = lib.removePrefix "${toString root}/" (toString path);
      value = import path;
    })
    declarationPaths;
  normalize = declaration:
    let
      app = declaration.value;
      cloudflare = app.cloudflare or null;
      cloudflareOrigin = if cloudflare == null then null else cloudflare.origin or null;
      valid =
        app.schemaVersion == 1
        && builtins.match "[a-z0-9][a-z0-9-]{0,63}" app.id != null
        && builtins.elem app.tailnet.audience [ "owner" "family" "machines" ]
        && builtins.match "[a-z0-9][a-z0-9-]{0,63}" app.tailnet.service.name != null
        && app.tailnet.service.port > 0
        && app.tailnet.service.port < 65536
        && (cloudflare == null || (
          builtins.elem cloudflare.audience [ "owner" "family" ]
          && builtins.match "[a-z0-9.-]+" cloudflare.hostname != null
          && builtins.match "[a-z0-9][a-z0-9-]{0,63}" cloudflare.connectorTrust != null
          && builtins.hasAttr cloudflare.connectorTrust connectorTags
          && builtins.isString cloudflare.tunnelName
          && builtins.isString cloudflare.accessName
          && (cloudflareOrigin == null || (
            builtins.match "https://[a-z0-9.-]+:[0-9]+" cloudflareOrigin.service != null
            && builtins.match "[a-z0-9.-]+" cloudflareOrigin.serverName != null
            && builtins.match "[a-z0-9][a-z0-9-]{0,63}" cloudflareOrigin.policyDestination != null
            && cloudflareOrigin.port > 0
            && cloudflareOrigin.port < 65536
          ))
        ));
    in
    if !valid then
      throw "invalid tailnet app declaration: ${declaration.source}"
    else {
      inherit (app)
        description
        id
        path
        schemaVersion
        title
        ;
      inherit (app) tailnet;
      inherit cloudflare;
      source = declaration.source;
    };
  catalog = lib.foldl'
    (result: declaration:
      let
        app = normalize declaration;
      in
      if !builtins.hasAttr app.id result then
        result // { ${app.id} = app; }
      else if builtins.toJSON result.${app.id} == builtins.toJSON app then
        result
      else
        throw "conflicting tailnet app declarations for ${app.id}: ${result.${app.id}.source} and ${app.source}")
    { }
    declarations;
  connectorTags = {
    files = "tag:cf-files-ingress";
    shared = "tag:cf-ingress";
    t3 = "tag:cf-t3-ingress";
  };
in
{
  inherit catalog connectorTags;

  cloudflareApps = lib.filterAttrs (_: app: app.cloudflare != null) catalog;

  tailscaleServices = {
    "svc:apps" = {
      comment = "portable app directory";
      ports = [ "tcp:443" ];
    };
  } // lib.mapAttrs'
    (_: app: lib.nameValuePair "svc:${app.tailnet.service.name}" {
      comment = app.description;
      ports = [ "tcp:${toString app.tailnet.service.port}" ];
    })
    catalog;

  capabilities = lib.mapAttrs
    (_: app:
      let
        cloudflareOrigin =
          if app.cloudflare == null then null else app.cloudflare.origin or null;
      in
      {
        service = "svc:${app.tailnet.service.name}:${toString app.tailnet.service.port}";
        tailnetAudience = app.tailnet.audience;
        connectorTrust = if app.cloudflare == null then null else app.cloudflare.connectorTrust;
        connectorDestination =
          if app.cloudflare == null then null
          else if cloudflareOrigin == null then
            "svc:${app.tailnet.service.name}:${toString app.tailnet.service.port}"
          else
            "${cloudflareOrigin.policyDestination}:${toString cloudflareOrigin.port}";
      })
    catalog;
}
