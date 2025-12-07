import Quickshell
import Quickshell.Wayland
import Quickshell.Hyprland
import QtQuick
import QtQuick.Layouts

PanelWindow {
    id: bar

    property int barHeight: 30
    property bool hyprlandAvailable: typeof Hyprland !== "undefined"
    property bool isHyprland: hyprlandAvailable && Hyprland.workspaces.count > 0

    anchors {
        top: true
        left: true
        right: true
    }

    implicitHeight: barHeight
    color: "#000000"

    WlrLayershell.layer: WlrLayer.Top
    WlrLayershell.namespace: "quickshell-bar"

    exclusiveZone: barHeight

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
            font.pixelSize: 16
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
            color: "#ffffff"
            font.family: "Berkeley Mono"
            font.pixelSize: 16
            Layout.alignment: Qt.AlignVCenter

            property date currentTime: new Date()

            text: Qt.formatDateTime(currentTime, "yyyy-MM-dd HH:mm")

            Timer {
                interval: 1000
                running: true
                repeat: true
                onTriggered: clock.currentTime = new Date()
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
                    font.pixelSize: 16
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
