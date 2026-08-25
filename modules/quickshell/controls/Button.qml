// Button.qml
// Fluid Functionalism button port.
// why: upstream button makes state changes legible with fast color transitions,
//      a pressed scale, variant-specific backgrounds, and size contracts.
//
// @prop variant - "primary" | "secondary" | "tertiary" | "ghost"
// @prop size - "sm" | "md" | "lg" | "icon-sm" | "icon" | "icon-lg"
// @prop loading - disables the button and shows the loading spinner
// @prop active - forces the engaged visual state

import QtQuick
import QtQuick.Layouts
import QtQuick.Shapes
import "../design" as Design
import "../primitives" as Primitives

Primitives.Surface {
    id: root

    property string variant: "primary"
    property string size: "md"
    property string text: ""
    property bool loading: false
    property bool active: false
    property bool hovered: false
    property bool pressed: false
    property bool iconOnly: size === "icon-sm" || size === "icon" || size === "icon-lg"

    signal clicked

    enabled: !loading
    substrateLevel: 1
    surfaceOffset: 2
    shadowLevel: 1
    radiusToken: "md"
    showShadow: false
    showBorder: variant === "tertiary" || variant === "outline"
    clipContent: true

    implicitWidth: iconOnly ? buttonHeight : Math.max(content.implicitWidth + horizontalPadding * 2, 64)
    implicitHeight: buttonHeight
    scale: pressed ? 0.98 : 1

    readonly property int buttonHeight: {
        switch (size) {
            case "sm": return 28
            case "lg": return 36
            case "icon-sm": return 32
            case "icon": return 36
            case "icon-lg": return 40
            default: return 32
        }
    }

    readonly property int horizontalPadding: {
        switch (size) {
            case "sm": return 12
            case "lg": return 20
            default: return 16
        }
    }

    readonly property int labelSize: {
        switch (size) {
            case "sm": return 12
            case "lg": return 14
            default: return 13
        }
    }

    surfaceColor: {
        if (!enabled) return backgroundForVariant(variant, false, false, false)
        return backgroundForVariant(variant, hovered, pressed, active)
    }

    opacity: enabled ? 1 : 0.5

    transformOrigin: Item.Center
    Behavior on scale {
        NumberAnimation { duration: Design.Theme.t.durationFast; easing.type: Easing.OutQuad }
    }

    function backgroundForVariant(name, isHovered, isPressed, isActive) {
        if (isActive) {
            switch (name) {
                case "primary": return Qt.rgba(Design.Theme.t.foreground.r, Design.Theme.t.foreground.g, Design.Theme.t.foreground.b, 0.80)
                case "secondary": return Design.Theme.t.accent
                case "tertiary": return Design.Theme.t.activeOverlay
                case "ghost": return Design.Theme.t.activeOverlay
                case "outline": return Design.Theme.t.activeOverlay
                case "fill": return Qt.rgba(Design.Theme.t.foreground.r, Design.Theme.t.foreground.g, Design.Theme.t.foreground.b, 0.80)
                default: return Design.Theme.t.activeOverlay
            }
        }

        switch (name) {
            case "primary":
            case "fill":
                if (isPressed) return Qt.rgba(Design.Theme.t.foreground.r, Design.Theme.t.foreground.g, Design.Theme.t.foreground.b, 0.80)
                if (isHovered) return Qt.rgba(Design.Theme.t.foreground.r, Design.Theme.t.foreground.g, Design.Theme.t.foreground.b, 0.90)
                return Design.Theme.t.foreground
            case "secondary":
                return isHovered ? Design.Theme.t.overlayOn(Design.Theme.t.accent, 0.10) : Design.Theme.t.accent
            case "tertiary":
            case "ghost":
            case "outline":
                if (isPressed) return Design.Theme.t.activeOverlay
                if (isHovered) return Design.Theme.t.hover
                return "transparent"
            default:
                return "transparent"
        }
    }

    function textColorForVariant(name) {
        switch (name) {
            case "primary":
            case "fill":
                return Design.Theme.t.background
            case "ghost":
                return hovered || pressed || active ? Design.Theme.t.foreground : Design.Theme.t.mutedForeground
            default:
                return Design.Theme.t.foreground
        }
    }

    RowLayout {
        id: content
        anchors.centerIn: parent
        spacing: size === "sm" ? 4 : 6
        visible: !root.loading

        Primitives.T {
            text: root.text
            tone: "fg"
            font.pixelSize: root.labelSize
            color: root.textColorForVariant(root.variant)
            visible: !root.iconOnly && root.text.length > 0
            Layout.alignment: Qt.AlignVCenter

            Behavior on color {
                ColorAnimation { duration: Design.Theme.t.durationFast }
            }
        }
    }

    Shape {
        id: spinner
        anchors.centerIn: parent
        width: 24
        height: 24
        visible: root.loading

        ShapePath {
            strokeColor: root.textColorForVariant(root.variant)
            strokeWidth: 1.125
            fillColor: "transparent"
            capStyle: ShapePath.RoundCap
            startX: 12
            startY: 12
            PathCubic { x: 19; y: 12; control1X: 14; control1Y: 8.5; control2X: 19; control2Y: 8.5 }
            PathCubic { x: 12; y: 12; control1X: 19; control1Y: 15.5; control2X: 14; control2Y: 15.5 }
            PathCubic { x: 5; y: 12; control1X: 10; control1Y: 8.5; control2X: 5; control2Y: 8.5 }
            PathCubic { x: 12; y: 12; control1X: 5; control1Y: 15.5; control2X: 10; control2Y: 15.5 }
        }

        RotationAnimator on rotation {
            running: root.loading
            from: 0
            to: 360
            duration: 1200
            loops: Animation.Infinite
        }
    }

    MouseArea {
        anchors.fill: parent
        enabled: root.enabled
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor

        onEntered: root.hovered = true
        onExited: {
            root.hovered = false
            root.pressed = false
        }
        onPressed: root.pressed = true
        onReleased: {
            const wasInside = containsMouse
            root.pressed = false
            if (wasInside) root.clicked()
        }
        onCanceled: root.pressed = false
    }
}
