import Quickshell
import Quickshell.Wayland
import Quickshell.Hyprland
import QtQuick
import QtQuick.Layouts

PanelWindow {
    id: bar

    property int barHeight: 45
    property bool hyprlandAvailable: typeof Hyprland !== "undefined"
    property bool isHyprland: hyprlandAvailable && Hyprland.workspaces.count > 0
    property var niriState: null
    property bool isFullscreen: niriState ? niriState.isFullscreen : false
    property bool controlCenterOpen: false
    property bool barVisible: false
    signal controlCenterToggled()

    anchors {
        top: true
        left: true
        right: true
    }

    implicitHeight: barVisible && !isFullscreen ? barHeight : 0
    visible: barVisible && !isFullscreen
    color: "#000000"

    WlrLayershell.layer: WlrLayer.Top
    WlrLayershell.namespace: "quickshell-bar"

    exclusiveZone: barVisible && !isFullscreen ? barHeight : 0

    Component.onCompleted: {
        if (niriState) niriState.setScreenSize(screen.width, screen.height)
    }

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 8
        anchors.rightMargin: 8
        spacing: 0

        Text {
            id: logo
            text: "∗"
            color: "#ffffff"
            font.family: "Berkeley Mono"
            font.pixelSize: 24
            Layout.alignment: Qt.AlignVCenter
        }

        Item { Layout.preferredWidth: 8 }

        Loader {
            id: workspacesLoader
            Layout.alignment: Qt.AlignVCenter
            sourceComponent: bar.isHyprland ? hyprlandWorkspaces : niriWorkspaces
        }

        Item { Layout.fillWidth: true }

        Text {
            id: clock
            color: clockMouse.containsMouse || bar.controlCenterOpen ? "#d1d5db" : "#ffffff"
            font.family: "Berkeley Mono"
            font.pixelSize: 24
            Layout.alignment: Qt.AlignVCenter

            property date currentTime: new Date()

            text: Qt.formatDateTime(currentTime, "yyyy-MM-dd HH:mm")

            Behavior on color {
                ColorAnimation { duration: 100; easing.type: Easing.OutQuint }
            }

            Timer {
                interval: 1000
                running: true
                repeat: true
                onTriggered: clock.currentTime = new Date()
            }

            MouseArea {
                id: clockMouse
                anchors.fill: parent
                anchors.margins: -4
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: bar.controlCenterToggled()
            }
        }
    }

    Component {
        id: hyprlandWorkspaces

        Row {
            spacing: 0

            Repeater {
                model: Hyprland.workspaces

                Text {
                    required property HyprlandWorkspace modelData

                    text: "[" + modelData.id + "]"
                    color: modelData.id === Hyprland.focusedWorkspace?.id ? "#d1d5db" : "#6b7280"
                    font.family: "Berkeley Mono"
                    font.pixelSize: 24
                    font.bold: modelData.id === Hyprland.focusedWorkspace?.id

                    MouseArea {
                        anchors.fill: parent
                        onClicked: Hyprland.dispatch("workspace " + modelData.id)
                    }
                }
            }
        }
    }

    Component {
        id: niriWorkspaces

        Row {
            spacing: 0

            NiriWorkspacesLoader {}
        }
    }
}
