// Tokens.qml
// Design token constants. Centralized so changes propagate everywhere.
// Why: hardcoded values scattered across components make consistent theming impossible.
//      tokens enable systematic adjustments without hunting through files.

pragma Singleton
import QtQuick

QtObject {
    // colors
    // semantic naming based on usage patterns in the shell
    property color black: "#000000"
    property color white: "#ffffff"
    property color gray100: "#d1d5db"  // hover states, active indicators
    property color gray300: "#9ca3af"   // secondary text, muted content
    property color gray400: "#6b7280"   // inactive, placeholder text
    property color gray500: "#4b5563"   // disabled, subtle elements
    property color gray700: "#374151"   // borders on hover
    property color gray800: "#1f2937"   // elevated surfaces, buttons

    // spacing scale (base 4, naming follows tailwind conventions)
    property int space1: 4
    property int space2: 8
    property int space3: 12
    property int space4: 16
    property int space6: 24
    property int space8: 32

    // typography scale
    property int text2xs: 11  // captions, metadata
    property int textXs: 12   // body small
    property int textSm: 14   // body medium
    property int textBase: 16 // body large, buttons
    property int text2xl: 24  // titles, clock, logo

    // radius scale
    property int radiusSm: 4   // buttons, inputs, small elements
    property int radiusMd: 8     // cards, panels, large surfaces

    // motion timing
    property int durationFast: 50   // immediate feedback (width, position)
    property int durationMed: 100  // color, opacity transitions
    property int durationSlow: 150 // emphasis animations
}
