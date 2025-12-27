import Quickshell
import Quickshell.Wayland
import QtQuick

ShellRoot {
    id: root

    property alias niriState: _niriState
    property bool controlCenterOpen: false

    NiriState {
        id: _niriState
    }

    Variants {
        model: Quickshell.screens

        Bar {
            required property var modelData
            screen: modelData
            niriState: root.niriState
            controlCenterOpen: root.controlCenterOpen
            onControlCenterToggled: root.controlCenterOpen = !root.controlCenterOpen
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
