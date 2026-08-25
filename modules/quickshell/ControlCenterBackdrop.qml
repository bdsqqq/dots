import Quickshell
import Quickshell.Wayland
import QtQuick

PanelWindow {
    id: backdrop

    required property var screen
    property bool isOpen: false

    signal clicked()

    anchors {
        top: true
        bottom: true
        left: true
        right: true
    }

    visible: isOpen
    color: "transparent"

    WlrLayershell.layer: WlrLayer.Top
    WlrLayershell.namespace: "quickshell-backdrop"

    exclusiveZone: 0

    MouseArea {
        anchors.fill: parent
        onClicked: backdrop.clicked()
    }
}
