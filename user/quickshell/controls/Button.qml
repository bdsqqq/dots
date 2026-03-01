// Button.qml
// Button control with semantic variants.
// why: buttons share a common structure (surface + text + interaction) but differ in emphasis.
//      variant prop handles visual weight: ghost (subtle), outline (medium), fill (strong).
//
// @prop variant - "ghost" | "outline" | "fill" — controls background and border presence
// @prop text - label string
// @prop enabled - disables interaction and mutes styling when false
// @signal clicked - emitted on press release inside bounds

import QtQuick
import "../design" as Design
import "../primitives" as Primitives

Primitives.Surface {
    id: root

    property string variant: "ghost"
    property string text: ""
    property bool enabled: true
    signal clicked

    // button sizing
    implicitWidth: Math.max(64, content.implicitWidth + Design.Theme.t.space4 * 2)
    implicitHeight: 32

    // visual state tracking
    property bool hovered: false
    property bool pressed: false

    // variant-driven styling
    surfaceColor: {
        if (!enabled) return Design.Theme.t.inactive
        if (pressed) return Design.Theme.t.bgHover
        if (variant === "fill") return Design.Theme.t.fg
        return Design.Theme.t.bg
    }

    showBorder: variant === "outline" || (variant === "ghost" && hovered)
    radiusToken: "sm"

    // content layout
    Row {
        id: content
        anchors.centerIn: parent
        spacing: Design.Theme.t.space2

        Primitives.T {
            id: label
            text: root.text
            tone: !root.enabled ? "muted" : (variant === "fill" ? "bg" : "fg")
            size: "bodySm"
            anchors.verticalCenter: parent.verticalCenter
        }
    }

    // interaction handling
    MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        enabled: root.enabled

        onEntered: root.hovered = true
        onExited: root.hovered = false
        onPressed: root.pressed = true
        onReleased: {
            root.pressed = false
            if (containsMouse) root.clicked()
        }
    }

    // state transitions
    Behavior on surfaceColor {
        ColorAnimation { duration: Design.Theme.t.durationMed }
    }
}
