pragma Singleton

// Tokens.qml
// Design token constants. Centralized so changes propagate everywhere.
// Why: hardcoded values scattered across components make consistent theming impossible.
//      tokens enable systematic adjustments without hunting through files.

import QtQuick
import Quickshell
import Quickshell.Io

Item {
    id: root
    visible: false

    readonly property string stateRoot: Quickshell.env("XDG_STATE_HOME") || Quickshell.env("HOME") + "/.local/state"
    readonly property string modePath: stateRoot + "/theme-mode"
    property string mode: "dark"
    readonly property bool isLight: mode === "light"

    // e-ink base16 colors
    property color base00: isLight ? "#CCCCCC" : "#101010"
    property color base01: isLight ? "#C2C2C2" : "#3D3D3D"
    property color base02: isLight ? "#B8B8B8" : "#4A4A4A"
    property color base03: isLight ? "#AEAEAE" : "#5E5E5E"
    property color base04: isLight ? "#9A9A9A" : "#727272"
    property color base05: isLight ? "#868686" : "#C2C2C2"
    property color base06: isLight ? "#5E5E5E" : "#CCCCCC"
    property color base07: isLight ? "#333333" : "#EEEEEE"

    // e-ink-glass material colors
    property color black: isLight ? base07 : base00
    property color white: isLight ? base00 : base07
    property color glass: isLight ? Qt.rgba(0.8, 0.8, 0.8, 0.72) : Qt.rgba(0.063, 0.063, 0.063, 0.72)
    property color glassHover: isLight ? Qt.rgba(0.761, 0.761, 0.761, 0.82) : Qt.rgba(0.239, 0.239, 0.239, 0.82)
    property color glassBorder: isLight ? Qt.rgba(0.682, 0.682, 0.682, 0.45) : Qt.rgba(0.369, 0.369, 0.369, 0.45)

    // semantic colors - use these in components
    property color fg: base05
    property color muted: base04
    property color subtle: base03
    property color bg: glass
    property color bgHover: glassHover
    property color border: glassBorder
    property color active: base07
    property color inactive: isLight ? Qt.rgba(0.8, 0.8, 0.8, 0.55) : Qt.rgba(0.063, 0.063, 0.063, 0.55)

    // spacing scale
    property int space1: 4
    property int space2: 8
    property int space3: 12
    property int space4: 16
    property int space6: 24
    property int space8: 32

    // typography scale
    property int text2xs: 11
    property int textXs: 12
    property int textSm: 14
    property int textBase: 16
    property int text2xl: 24

    // semantic typography
    property int bodySm: textXs
    property int bodyMd: textSm
    property int titleLg: text2xl

    // radius scale
    property int radiusSm: 4
    property int radiusMd: 8

    // motion timing
    property int durationFast: 50
    property int durationMed: 100
    property int durationSlow: 150

    function applyMode(content) {
        const next = (content || "").trim()
        root.mode = next === "light" ? "light" : "dark"
    }

    FileView {
        id: themeModeFile
        path: root.modePath
        blockLoading: false
        blockWrites: false
        watchChanges: true
        printErrors: false
    }

    Connections {
        target: themeModeFile

        function onLoaded() {
            root.applyMode(themeModeFile.text())
        }

        function onLoadFailed() {
            root.mode = "dark"
        }
    }
}
