// Tokens.qml
// Design token constants. Centralized so changes propagate everywhere.
// Why: hardcoded values scattered across components make consistent theming impossible.
//      tokens enable systematic adjustments without hunting through files.

pragma Singleton
import QtQuick

QtObject {
    id: root

    // base colors
    property color black: "#000000"
    property color white: "#ffffff"
    property color gray100: "#d1d5db"
    property color gray300: "#9ca3af"
    property color gray400: "#6b7280"
    property color gray500: "#4b5563"
    property color gray700: "#374151"
    property color gray800: "#1f2937"

    // semantic colors - use these in components
    property color fg: white
    property color muted: gray300
    property color subtle: gray400
    property color bg: gray800
    property color bgHover: gray700
    property color border: gray500
    property color active: white
    property color inactive: gray800

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
}
