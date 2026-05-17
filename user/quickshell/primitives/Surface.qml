// Surface.qml
// Fluid Functionalism surface primitive for consistent elevation, radius, and border.
// why: upstream components are built on an 8-level surface ladder. keeping that
//      contract in one primitive lets controls compose the same elevation model.
//
// @prop level - Fluid surface level 1..8
// @prop shadowLevel - shadow strength level 1..8, defaults to level
// @prop radiusToken - "sm" | "md" | "lg" | "xl" | "pill" | "rounded-sm" | "rounded-md"
// @prop showBorder - whether to draw the 1px border/ring

import QtQuick
import "../design" as Design

Item {
    id: root

    default property alias contentData: content.data

    property int substrateLevel: 1
    property int surfaceOffset: 2
    property int level: Design.Theme.t.elevatedLevel(substrateLevel, surfaceOffset)
    property int shadowLevel: level
    property color surfaceColor: Design.Theme.t.surface(level)
    property string radiusToken: "md"
    property bool showBorder: true
    property bool showShadow: true
    property bool clipContent: true

    implicitWidth: Math.max(content.implicitWidth, surface.implicitWidth)
    implicitHeight: Math.max(content.implicitHeight, surface.implicitHeight)

    function radiusForToken(token) {
        switch (token) {
            case "sm": return Design.Theme.t.radiusSm
            case "md": return Design.Theme.t.radiusMd
            case "lg": return Design.Theme.t.radiusLg
            case "xl": return Design.Theme.t.radiusXl
            case "pill": return Design.Theme.t.radiusPill
            case "rounded-sm": return Design.Theme.t.radiusRoundedSm
            case "rounded-md": return Design.Theme.t.radiusRoundedMd
            default: return Design.Theme.t.radiusMd
        }
    }

    Repeater {
        model: root.showShadow ? Math.max(0, Math.min(8, root.shadowLevel) - 1) : 0

        Rectangle {
            readonly property int shadowLayer: index + 1
            readonly property real shadowOffset: Math.pow(2, shadowLayer - 1)

            x: surface.x
            y: surface.y + Math.max(1, shadowOffset / 8)
            width: surface.width
            height: surface.height
            radius: surface.radius
            color: "transparent"
            border.width: 1
            border.color: Qt.rgba(0, 0, 0, Design.Theme.t.shadowOpacity(root.shadowLevel) / (shadowLayer + 1))
            z: -1
        }
    }

    Rectangle {
        id: surface
        anchors.fill: parent
        color: root.surfaceColor
        radius: root.radiusForToken(root.radiusToken)
        border.color: root.showBorder ? Design.Theme.t.border : "transparent"
        border.width: root.showBorder ? 1 : 0

        Behavior on color {
            ColorAnimation { duration: Design.Theme.t.durationFast }
        }

        Behavior on border.color {
            ColorAnimation { duration: Design.Theme.t.durationFast }
        }
    }

    Item {
        id: content
        anchors.fill: parent
        clip: root.clipContent
    }
}
