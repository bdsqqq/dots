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

    property var bg: Design.Theme.t.c.bg
    property string radius: "md"
    property bool border: false
    property int padding: Design.Theme.t.space2  // default 8px, consumer can override

    // always clip children to bounds — surfaces are containers
    clip: true

    // apply background color
    color: bg

    // map radius token to actual value
    radius: {
        switch (root.radius) {
            case "sm": return Design.Theme.t.radius.sm
            case "md": return Design.Theme.t.radius.md
            default: return Design.Theme.t.radius.md
        }
    }

    // border styling when enabled
    border.color: border ? Design.Theme.t.c.border : "transparent"
    border.width: border ? 1 : 0
}
