import Quickshell
import Quickshell.Wayland
import Quickshell.Io
import QtQuick

import "overlays" as Overlays

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

    // volume key handler: shows OSD on all screens
    IpcHandler {
        target: "volume"

        function showOsd(): void {
            const hosts = overlayHosts.instances
            for (let i = 0; i < hosts.length; i++) {
                const host = hosts[i]
                if (host && host.show) {
                    host.show(Overlays.OsdVolume, {}, { timeoutMs: 2000 })
                }
            }
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

    // keep control center overlay standalone (no fullscreen backdrop).
    // why: backdrop eats clicks intended for apps when control center is open.
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

    // per-screen overlay host for OSDs
    Variants {
        id: overlayHosts
        model: Quickshell.screens

        Overlays.OverlayHost {
            required property var modelData
            screen: modelData
        }
    }

}
