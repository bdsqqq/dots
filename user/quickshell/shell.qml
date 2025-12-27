import Quickshell
import Quickshell.Wayland
import QtQuick

ShellRoot {
    id: root

    property alias niriState: _niriState

    NiriState {
        id: _niriState
    }

    Variants {
        model: Quickshell.screens

        Bar {
            required property var modelData
            screen: modelData
            niriState: root.niriState
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
