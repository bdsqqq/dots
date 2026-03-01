// Surface.qml
// Rectangle primitive for consistent surface styling.
// why: surfaces need coordinated decisions — bg color, radius, border presence, padding.
//      hardcoding these in every component leads to visual inconsistency and refactoring pain.
//
// @prop bg - color token for background
// @prop radiusSize - radius token size "sm" | "md"
// @prop showBorder - whether to draw a border
// @prop padding - spacing token applied via defaultLayout, consumers can override

import QtQuick
import "../design" as Design

Rectangle {
    id: root

    property var bg: Design.Theme.t.bg
    property string radiusSize: "md"
    property bool showBorder: false
    property int padding: Design.Theme.t.space2

    clip: true
    color: bg
    radius: root.radiusSize === "sm" ? Design.Theme.t.radiusSm : Design.Theme.t.radiusMd

    border.color: showBorder ? Design.Theme.t.border : "transparent"
    border.width: showBorder ? 1 : 0
}
