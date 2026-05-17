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

    // e-ink base16 colors retained for host theme bridges and older components.
    property color base00: isLight ? "#CCCCCC" : "#101010"
    property color base01: isLight ? "#C2C2C2" : "#3D3D3D"
    property color base02: isLight ? "#B8B8B8" : "#4A4A4A"
    property color base03: isLight ? "#AEAEAE" : "#5E5E5E"
    property color base04: isLight ? "#9A9A9A" : "#727272"
    property color base05: isLight ? "#868686" : "#C2C2C2"
    property color base06: isLight ? "#5E5E5E" : "#CCCCCC"
    property color base07: isLight ? "#333333" : "#EEEEEE"

    // Fluid Functionalism surface ladder, ported from app/globals.css.
    // why: components should consume the same elevation model as the upstream library:
    //      light mode uses subtle floor colors + shadows; dark mode uses additive lightness.
    property color surface1: isLight ? "#FAFAFA" : "#171717"
    property color surface2: isLight ? "#FCFCFC" : "#1E1E1E"
    property color surface3: isLight ? "#FFFFFF" : "#252525"
    property color surface4: isLight ? "#FFFFFF" : "#2C2C2C"
    property color surface5: isLight ? "#FFFFFF" : "#333333"
    property color surface6: isLight ? "#FFFFFF" : "#3A3A3A"
    property color surface7: isLight ? "#FFFFFF" : "#414141"
    property color surface8: isLight ? "#FFFFFF" : "#484848"

    property color background: surface1
    property color foreground: isLight ? "#171717" : "#F5F5F5"
    property color card: surface3
    property color cardForeground: foreground
    property color mutedSurface: surface2
    property color mutedForeground: isLight ? "#737373" : "#A3A3A3"
    property color accent: isLight ? "#E5E5E5" : "#525252"
    property color accentForeground: foreground
    property color selected: isLight ? "#D4D4D4" : "#525252"
    property color ring: isLight ? "#E5E5E5" : "#404040"
    property color input: isLight ? "#E5E5E5" : "#404040"
    property color border: overlayColor(isLight ? 0.12 : 0.12)
    property color hover: overlayColor(0.06)
    property color activeOverlay: overlayColor(0.10)
    // Compatibility semantic colors - mapped to Fluid tokens.
    property color black: background
    property color white: foreground
    property color glass: card
    property color glassHover: overlayOn(card, 0.06)
    property color glassBorder: border
    property color fg: foreground
    property color muted: mutedForeground
    property color subtle: isLight ? "#A3A3A3" : "#737373"
    property color bg: card
    property color bgHover: hover
    property color active: selected
    property color inactive: accent

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

    // radius scale. Fluid's default shape is pill; rounded is available for denser surfaces.
    property int radiusSm: 8
    property int radiusMd: 20
    property int radiusLg: 24
    property int radiusXl: 28
    property int radiusRoundedSm: 8
    property int radiusRoundedMd: 12
    property int radiusPill: 20

    // motion timing from Fluid Functionalism spring tokens.
    property int durationFast: 80
    property int durationMed: 160
    property int durationSlow: 240

    function overlayColor(alpha) {
        return isLight ? Qt.rgba(0, 0, 0, alpha) : Qt.rgba(1, 1, 1, alpha)
    }

    function overlayOn(base, alpha) {
        const overlay = isLight ? 0 : 1
        return Qt.rgba(
            base.r * (1 - alpha) + overlay * alpha,
            base.g * (1 - alpha) + overlay * alpha,
            base.b * (1 - alpha) + overlay * alpha,
            base.a
        )
    }

    function surfaceLevel(level) {
        return Math.max(1, Math.min(8, level))
    }

    function elevatedLevel(substrate, offset, cap) {
        return surfaceLevel(Math.min(substrate + offset, cap ?? 8))
    }

    function surface(level) {
        switch (surfaceLevel(level)) {
            case 1: return surface1
            case 2: return surface2
            case 3: return surface3
            case 4: return surface4
            case 5: return surface5
            case 6: return surface6
            case 7: return surface7
            case 8: return surface8
            default: return surface3
        }
    }

    function elevatedSurface(substrate, offset, cap) {
        return surface(elevatedLevel(substrate, offset, cap))
    }

    function shadowOpacity(level) {
        const clamped = Math.max(1, Math.min(8, level))
        return isLight ? 0.035 + clamped * 0.012 : 0.12 + clamped * 0.018
    }

    function shadowRadius(level) {
        const clamped = Math.max(1, Math.min(8, level))
        return Math.pow(2, clamped - 1)
    }

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
