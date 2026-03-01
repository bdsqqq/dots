// Surface.qml
// Rectangle primitive for consistent surface styling.
// why: surfaces need coordinated decisions — bg color, radius, border presence, padding.
//      hardcoding these in every component leads to visual inconsistency and refactoring pain.
//
// @prop bg - color token for background (uses Theme.t.c.*)
// @prop radius - radius token size "sm" | "md" (uses Theme.t.radius.*)
// @prop border - whether to draw a border
// @prop padding - spacing token applied via defaultLayout, consumers can override

import QtQuick
import "../design" as Design

Rectangle {
    id: root

    property var bg: Design.Theme.t.bg
    property string radiusSize: "md"
    property bool border: false
    property int padding: Design.Theme.t.space2  // default 8px, consumer can override

    // always clip children to bounds — surfaces are containers
    clip: true

    // apply background color
    color: bg

    // map radius token to actual value - use binding directly, no property shadowing
    radius: root.radiusSize === "sm" ? Design.Theme.t.radiusSm : Design.Theme.t.radiusMd

    // border styling when enabled
    border.color: border ? Design.Theme.t.border : "transparent"
    border.width: border ? 1 : 0
}
