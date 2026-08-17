{ ... }: {
  home-manager.users.bdsqqq =
    { lib, pkgs, ... }:
    let
      nodeVersion = "24.18.0";
    in
    {
      home.packages = [ pkgs.mise ];
      xdg.configFile."mise/config.toml".text = ''
        [tools]
        node = "${nodeVersion}"

        [settings]
        idiomatic_version_file_enable_tools = ["node"]
      '';
      programs.zsh.initContent = ''
        # mise
        if [[ -t 1 ]] && command -v mise >/dev/null 2>&1; then
          eval "$(mise activate zsh)"
        fi
      '';

      home.activation.ensureMiseTools = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        if ! "${pkgs.mise}/bin/mise" where "node@${nodeVersion}" >/dev/null 2>&1; then
          "${pkgs.mise}/bin/mise" install --yes "node@${nodeVersion}"
        fi
      '';
    };
}
