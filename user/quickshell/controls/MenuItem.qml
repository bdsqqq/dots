// MenuItem.qml
// Fluid Functionalism menu/list row port.
// why: selectable rows are not mini-cards. upstream uses a lightweight row with
//      13px text, 8px horizontal padding, hover preview, and semibold selected text.
//
// @prop label - primary row text
// @prop detail - optional trailing/status text
// @prop checked - selected/current row state
// @signal selected - emitted when activated

import QtQuick
import QtQuick.Layouts
import "../design" as Design

Item {
    id: root

    property string label: ""
    property string detail: ""
    property bool checked: false
    property bool hovered: false

    signal selected

    implicitHeight: 32

    Rectangle {
        anchors.fill: parent
        radius: Design.Theme.t.radiusRoundedSm
        color: root.checked ? Design.Theme.t.activeOverlay : (root.hovered ? Design.Theme.t.hover : "transparent")

        Behavior on color {
            ColorAnimation { duration: Design.Theme.t.durationFast }
        }
    }

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 8
        anchors.rightMargin: 8
        spacing: 8

        Text {
            text: root.label
            color: root.checked || root.hovered ? Design.Theme.t.foreground : Design.Theme.t.mutedForeground
            font.family: "Berkeley Mono"
            font.pixelSize: 13
            font.weight: root.checked ? Font.DemiBold : Font.Normal
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
            color: root.checked ? Design.Theme.t.foreground : Design.Theme.t.mutedForeground
            font.family: "Berkeley Mono"
            font.pixelSize: 13
            font.weight: root.checked ? Font.DemiBold : Font.Normal
            elide: Text.ElideRight
            horizontalAlignment: Text.AlignRight
            Layout.maximumWidth: Math.max(48, root.width * 0.35)
            Layout.alignment: Qt.AlignVCenter

            Behavior on color {
                ColorAnimation { duration: Design.Theme.t.durationFast }
            }
        }
    }

    MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor

        onEntered: root.hovered = true
        onExited: root.hovered = false
        onClicked: root.selected()
    }
}
