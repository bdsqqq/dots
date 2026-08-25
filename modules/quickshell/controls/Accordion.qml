// Accordion.qml
// Fluid Functionalism accordion port.
// why: accordion state should be readable without extra labels: open items get a
//      soft active surface, hovered triggers preview the click target, and the
//      chevron/text weight make expansion legible.
//
// @prop title - trigger label
// @prop expanded - external open state
// @prop disabled - disables interaction
// @signal toggled(expanded) - emitted when trigger is clicked

import QtQuick
import QtQuick.Layouts
import "../design" as Design

Item {
    id: root

    default property alias contentData: contentColumn.data

    property string title: ""
    property string detail: ""
    property bool expanded: false
    property bool disabled: false
    property bool hovered: false

    signal toggled(bool expanded)

    implicitWidth: Math.max(trigger.implicitWidth, contentFrame.implicitWidth)
    implicitHeight: trigger.height + contentFrame.height
    opacity: disabled ? 0.5 : 1

    Rectangle {
        id: openBackground
        anchors.fill: parent
        radius: Design.Theme.t.radiusMd
        color: Design.Theme.t.accent
        opacity: root.expanded ? (Design.Theme.t.isLight ? 0.20 : 0.12) : 0

        Behavior on opacity {
            NumberAnimation { duration: Design.Theme.t.durationFast; easing.type: Easing.OutQuad }
        }
    }

    Rectangle {
        id: hoverBackground
        x: trigger.x
        y: trigger.y
        width: trigger.width
        height: trigger.height
        radius: Design.Theme.t.radiusMd
        color: Design.Theme.t.hover
        opacity: root.hovered && !root.disabled ? 1 : 0

        Behavior on opacity {
            NumberAnimation { duration: Design.Theme.t.durationFast; easing.type: Easing.OutQuad }
        }
    }

    RowLayout {
        id: trigger
        x: 0
        y: 0
        width: root.width
        height: 32
        spacing: 10

        Item { width: 12; Layout.fillHeight: true }

        Text {
            id: label
            text: root.title
            color: root.expanded || root.hovered ? Design.Theme.t.foreground : Design.Theme.t.mutedForeground
            font.family: "Berkeley Mono"
            font.pixelSize: 13
            font.weight: root.expanded ? Font.DemiBold : Font.Normal
            elide: Text.ElideRight
            Layout.fillWidth: true
            Layout.alignment: Qt.AlignVCenter

            Behavior on color {
                ColorAnimation { duration: Design.Theme.t.durationFast }
            }
        }

        Text {
            text: root.detail
            visible: root.detail.length > 0
            color: root.expanded || root.hovered ? Design.Theme.t.foreground : Design.Theme.t.mutedForeground
            font.family: "Berkeley Mono"
            font.pixelSize: 13
            font.weight: root.expanded ? Font.DemiBold : Font.Normal
            elide: Text.ElideRight
            horizontalAlignment: Text.AlignRight
            Layout.maximumWidth: Math.max(80, root.width * 0.4)
            Layout.alignment: Qt.AlignVCenter

            Behavior on color {
                ColorAnimation { duration: Design.Theme.t.durationFast }
            }
        }

        Text {
            id: chevron
            text: "›"
            color: root.expanded || root.hovered ? Design.Theme.t.foreground : Design.Theme.t.mutedForeground
            font.family: "Berkeley Mono"
            font.pixelSize: 18
            font.weight: root.expanded || root.hovered ? Font.DemiBold : Font.Normal
            rotation: root.expanded ? 90 : 0
            Layout.preferredWidth: 16
            Layout.alignment: Qt.AlignVCenter
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter

            Behavior on rotation {
                NumberAnimation { duration: Design.Theme.t.durationFast; easing.type: Easing.OutQuad }
            }

            Behavior on color {
                ColorAnimation { duration: Design.Theme.t.durationFast }
            }
        }

        Item { width: 12; Layout.fillHeight: true }
    }

    Item {
        id: contentFrame
        x: 0
        y: trigger.height
        width: root.width
        height: root.expanded ? contentColumn.implicitHeight + 16 : 0
        clip: true

        Behavior on height {
            NumberAnimation { duration: Design.Theme.t.durationMed; easing.type: Easing.OutQuad }
        }

        ColumnLayout {
            id: contentColumn
            x: 12
            y: 4
            width: Math.max(0, contentFrame.width - 24)
            spacing: 2
        }
    }

    MouseArea {
        anchors.fill: trigger
        enabled: !root.disabled
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor

        onEntered: root.hovered = true
        onExited: root.hovered = false
        onClicked: root.toggled(!root.expanded)
    }
}
