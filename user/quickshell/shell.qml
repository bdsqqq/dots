import Quickshell
import Quickshell.Wayland
import Quickshell.Io
import QtQuick

ShellRoot {
    id: root

    property alias niriState: _niriState
    property bool controlCenterOpen: false
    property bool barVisible: false

    NiriState {
        id: _niriState
    }

    IpcHandler {
        target: "control-center"

        function toggleControlCenter(): void {
            root.controlCenterOpen = !root.controlCenterOpen
        }

        function open(): void {
            root.controlCenterOpen = true
        }

        function close(): void {
            root.controlCenterOpen = false
        }
    }

    IpcHandler {
        target: "bar"

        function toggle(): void {
            root.barVisible = !root.barVisible
        }

        function show(): void {
            root.barVisible = true
        }

        function hide(): void {
            root.barVisible = false
        }
    }

    Variants {
        model: Quickshell.screens

        Bar {
            required property var modelData
            screen: modelData
            niriState: root.niriState
            controlCenterOpen: root.controlCenterOpen
            barVisible: root.barVisible
            onControlCenterToggled: root.controlCenterOpen = !root.controlCenterOpen
        }
    }

    Variants {
        model: Quickshell.screens

        ControlCenterBackdrop {
            required property var modelData
            screen: modelData
            isOpen: root.controlCenterOpen
            onClicked: root.controlCenterOpen = false
        }
    }

    Variants {
        model: Quickshell.screens

        ControlCenter {
            required property var modelData
            screen: modelData
            isOpen: root.controlCenterOpen
        }
    }

    Variants {
        model: Quickshell.screens

        ScreenCorners {
            required property var modelData
            screen: modelData
        }
    }

    Variants {
        model: Quickshell.screens

        NotificationPopups {
            required property var modelData
            screen: modelData
        }
    }

}
