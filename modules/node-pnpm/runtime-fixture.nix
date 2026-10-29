{
  nodeModulePath ? ./default.nix,
  shellModulePath ? ../shell/default.nix,
}:
let
  lock = builtins.fromJSON (builtins.readFile ../../flake.lock);
  locked = lock.nodes.${lock.nodes.${lock.root}.inputs.nixpkgs}.locked;
  source = (builtins.getFlake "github:${locked.owner}/${locked.repo}/${locked.rev}").outPath;
  packageArgs = {
    system = "x86_64-linux";
    config.allowUnfree = true;
  };
  stock = import source packageArgs;
  nodeModule = import nodeModulePath {
    config.my.paths.commonplace = "/fixture/commonplace";
  };
  configured = import source (packageArgs // {
    overlays = nodeModule.nixpkgs.overlays or [ ];
  });
  home = nodeModule.home-manager.users.bdsqqq {
    pkgs = configured;
    config.home.homeDirectory = "/fixture/home";
    # Inspect the generated script without running an activation DAG.
    lib = stock.lib // { hm.dag.entryAfter = _: script: script; };
  };
  launcher = builtins.head (builtins.filter (package: package.name == "pnpm") home.home.packages);
  desktop = headMode: isDarwin:
    let
      pkgs = configured // {
        stdenv = { inherit isDarwin; isLinux = !isDarwin; };
        ghostty = "/fixture/ghostty";
        yazi = "/fixture/yazi";
      };
      module = import shellModulePath {
        inherit pkgs headMode;
        lib = stock.lib;
        config.my.primaryUser = "fixture";
      };
      shell = module.home-manager.users.bdsqqq {
        inherit pkgs;
        lib = stock.lib;
        config = { };
      };
    in {
      entries = shell.config.xdg.desktopEntries;
      mime = shell.config.xdg.mimeApps;
    };
in
{
  nixpkgsRevision = locked.rev;
  stockNode = stock.nodejs.outPath;
  defaultNode = configured.nodejs.outPath;
  latestNode = stock.nodejs_latest.outPath;
  stockGhostty = stock.ghostty.outPath;
  configuredGhostty = configured.ghostty.outPath;
  pnpm = configured.pnpm_12.outPath;
  homePackages = map (package: package.outPath) home.home.packages;
  launcher = launcher.outPath;
  launcherScript = launcher.text;
  pathSegments = home.custom.path.segments;
  installScript = home.home.activation.installPnpmTools;
  graphicalLinux = desktop "graphical" false;
  headlessLinux = desktop "headless" false;
  graphicalDarwin = desktop "graphical" true;
  headlessDarwin = desktop "headless" true;
}
