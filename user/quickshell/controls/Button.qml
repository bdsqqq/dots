// Button.qml
// Button control with semantic variants.
// why: buttons share a common structure (surface + text + interaction) but differ in emphasis.
//      variant prop handles visual weight: ghost (subtle), outline (medium), fill (strong).
//
// @prop variant - "ghost" | "outline" | "fill" — controls background and border presence
// @prop text - label string
// @prop onClicked - callback function invoked on press

import QtQuick
import "../design/Theme.qml" as Theme
import "../primitives/Surface.qml" as Surface
import "../primitives/T.qml" as T

Surface {
    id: root

    property string variant: "ghost"
    property string text: ""
    property var onClicked: function() {}

    // button sizing
    implicitWidth: Math.max(64, content.implicitWidth + Theme.t.space4 * 2)
    implicitHeight: 32

    // visual state tracking
    property bool hovered: false
    property bool pressed: false

    // variant-driven styling
    bg: {
        if (pressed) return Theme.t.c.bgHover
        if (variant === "fill") return Theme.t.c.fg
        return Theme.t.c.bg
    }

    border: variant === "outline" || (variant === "ghost" && hovered)
    radius: "sm"

    // content layout
    Row {
        id: content
        anchors.centerIn: parent
        spacing: Theme.t.space2

        T {
            id: label
            text: root.text
            tone: variant === "fill" ? "bg" : "fg"
            size: "bodySm"
            anchors.verticalCenter: parent.verticalCenter
        }
    }

    // interaction handling
    MouseArea {
        anchors.fill: parent
        hoverEnabled: true

        onEntered: root.hovered = true
        onExited: root.hovered = false
        onPressed: root.pressed = true
        onReleased: {
            root.pressed = false
            if (containsMouse) root.onClicked()
        }
    }

    // state transitions
    Behavior on bg {
        ColorAnimation { duration: Theme.t.durationMed }
    }
}
