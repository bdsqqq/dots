{ pkgs }:
let
  lib = pkgs.lib;
  homeDir = "/Users/bdsqqq";
  expectedLog = "${homeDir}/.local/state/log/wikiman-update/agent.log";

  wikimanModule = import ./default.nix {
    config = { };
    inherit lib pkgs;
    hostSystem = "aarch64-darwin";
  };
  wikimanHome = wikimanModule.home-manager.users.bdsqqq {
    config.home.homeDirectory = homeDir;
    inherit pkgs;
  };
  wikimanAgent = wikimanHome.launchd.agents.wikiman-update.content.config;
  logDirectoryMarker = wikimanHome.home.file.".local/state/log/wikiman-update/.keep";

  o11yModule = import ../o11y {
    inherit lib pkgs;
    hostSystem = "aarch64-darwin";
    config = {
      containers = { };
      networking.hostName = "test-darwin";
      services = {
        axiom-deploy-annotation.datasets = [ ];
        o11y = {
          enable = true;
          papertrail.eventFiles = [ ];
          processMetrics.enable = false;
        };
      };
    };
  };
  commonO11yConfig = builtins.elemAt o11yModule.config.content.contents 0;
  collectorConfig = commonO11yConfig.environment.etc."otelcol/axiom.yaml".source;
  python = pkgs.python3.withPackages (packages: [ packages.pyyaml ]);
in
assert wikimanAgent.StandardOutPath == expectedLog;
assert wikimanAgent.StandardErrorPath == expectedLog;
assert logDirectoryMarker.condition && logDirectoryMarker.content.text == "";
pkgs.runCommand "wikiman-logging-check"
{
  nativeBuildInputs = [ pkgs.opentelemetry-collector-contrib python ];
}
  ''
    export AXIOM_URL=https://example.invalid
    export AXIOM_TOKEN_LOGS=test
    export AXIOM_TOKEN_METRICS=test
    otelcol-contrib validate --config ${collectorConfig}

    python - <<'PY'
    import re
    from pathlib import Path

    import yaml

    config = yaml.safe_load(Path("${collectorConfig}").read_text())
    receiver = config["receivers"]["filelog/darwin_services"]
    assert "${homeDir}/.local/state/log/**/*.log" in receiver["include"]

    operators = receiver["operators"]
    app_parser = next(
        operator
        for operator in operators
        if operator.get("type") == "regex_parser"
        and "/[.]local/state/log/" in operator.get("regex", "")
    )
    match = re.fullmatch(app_parser["regex"], "${expectedLog}")
    assert match and match.group("app") == "wikiman-update"

    user_operator = next(
        operator
        for operator in operators
        if operator.get("field") == "attributes.user"
    )
    assert user_operator["value"] == "bdsqqq"
    assert "[.]local/state/log/" in user_operator["if"]
    PY

    touch "$out"
  ''
