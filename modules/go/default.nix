{ ... }: {
  home-manager.users.bdsqqq = { pkgs, ... }:
    let
      gotoolsWithoutModernize = pkgs.symlinkJoin {
        name = "gotools-without-modernize";
        paths = [ pkgs.gotools ];
        postBuild = ''
          rm "$out/bin/modernize"
        '';
      };
    in {
      home.packages = with pkgs; [
        go
        gopls # LSP
        gofumpt # formatter
        golangci-lint # linter
        gotoolsWithoutModernize # goimports, etc.; gopls also ships modernize
        gotests # test generator
        delve # debugger
      ];
    };
}
