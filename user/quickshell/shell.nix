# QML development shell for Quickshell configuration
# Provides: qmllint, qmlformat, qmlls with proper import paths

{ pkgs ? import <nixpkgs> {} }:

let
  quickshell = pkgs.quickshell;
  
  # Build import path arguments for qmllint
  qtQmlPath = "${pkgs.qt6.qtdeclarative}/lib/qt-6/qml";
  quickshellQmlPath = "${quickshell}/lib/qt-6/qml";
  
  # Wrapper script that always includes proper -I flags
  qmllintWrapped = pkgs.writeShellScriptBin "qmllint" ''
    exec ${pkgs.qt6.qtdeclarative}/bin/qmllint \
      -I "${quickshellQmlPath}" \
      -I "${qtQmlPath}" \
      "$@"
  '';
  
  qmlformatWrapped = pkgs.writeShellScriptBin "qmlformat" ''
    exec ${pkgs.qt6.qtdeclarative}/bin/qmlformat \
      -I "${quickshellQmlPath}" \
      -I "${qtQmlPath}" \
      "$@"
  '';
  
  qmllsWrapped = pkgs.writeShellScriptBin "qmlls" ''
    # qmlls uses QMLLS_BUILD_DIRS for type discovery
    export QMLLS_BUILD_DIRS="${quickshellQmlPath}:${qtQmlPath}"
    exec ${pkgs.qt6.qtdeclarative}/bin/qmlls "$@"
  '';

in

pkgs.mkShell {
  # Don't put qt6.qtdeclarative directly in PATH - use our wrapped versions
  packages = [
    qmllintWrapped          # wrapped with -I flags
    qmlformatWrapped        # wrapped with -I flags  
    qmllsWrapped            # wrapped with env var
    quickshell
    pkgs.just               # for justfile commands
    pkgs.entr               # file watcher for just watch
    # qt6.qtdeclarative libs needed but not the binaries in PATH
  ];

  shellHook = ''
    # Make sure our wrapped tools are first in PATH
    export PATH="${qmllintWrapped}/bin:${qmlformatWrapped}/bin:${qmllsWrapped}/bin:$PATH"
    
    export QML_IMPORT_PATH="${quickshellQmlPath}:${qtQmlPath}:$QML_IMPORT_PATH"
    export QMLLS_BUILD_DIRS="${quickshellQmlPath}:${qtQmlPath}"
    
    echo "╔═══════════════════════════════════════════════════════════════╗"
    echo "║           QML Tooling Environment (Quickshell)                ║"
    echo "╠═══════════════════════════════════════════════════════════════╣"
    echo "║  qmllint  - $(qmllint --version 2>/dev/null || echo 'available')                    ║"
    echo "║  qmlformat - code formatter (prettier for QML)                ║"
    echo "║  qmlls     - LSP server (run 'qmlls -E' for editor)           ║"
    echo "║  just      - task runner (run 'just' for commands)            ║"
    echo "╚═══════════════════════════════════════════════════════════════╝"
    echo ""
    echo "Pre-configured import paths:"
    echo "  Quickshell: ${quickshellQmlPath}"
    echo "  Qt:         ${qtQmlPath}"
    echo ""
    echo "Quick commands:"
    echo "  just lint        # lint all .qml files"
    echo "  just check       # lint shell.qml specifically"
    echo "  just watch       # lint continuously on file changes"
    echo "  just watch-file FILE  # watch specific file"
    echo "  just format      # format all files"
    echo "  just lsp         # start LSP server"
    echo "  qmllint file.qml # lint specific file (auto-imports configured)"
  '';
}
