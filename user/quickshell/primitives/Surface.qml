// Surface.qml
// Rectangle primitive for consistent surface styling.
// why: surfaces need coordinated decisions — bg color, radius, border presence, padding.
//      hardcoding these in every component leads to visual inconsistency and refactoring pain.
//
// @prop surfaceColor - semantic background color
// @prop radiusToken - radius token "sm" | "md"
// @prop showBorder - whether to draw a border

import QtQuick
import "../design" as Design

Rectangle {
    id: root

    property color surfaceColor: Design.Theme.t.bg
    property string radiusToken: "md"
    property bool showBorder: false

    // always clip children to bounds — surfaces are containers
    clip: true

    // apply background color
    color: surfaceColor

    // map radius token to actual value
    radius: {
        switch (root.radiusToken) {
            case "sm": return Design.Theme.t.radiusSm
            case "md": return Design.Theme.t.radiusMd
            default: return Design.Theme.t.radiusMd
        }
    }

    // border styling when enabled
    border.color: showBorder ? Design.Theme.t.border : "transparent"
    border.width: showBorder ? 1 : 0
}
