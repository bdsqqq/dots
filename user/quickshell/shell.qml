import Quickshell
import Quickshell.Wayland
import Quickshell.Io
import Quickshell.Services.Pipewire
import QtQuick

import "overlays" as Overlays

ShellRoot {
    id: root

    property alias niriState: _niriState
    property bool controlCenterOpen: false
    property bool barVisible: false

    function showVolumeOsd(): void {
        const hosts = overlayHosts.instances
        for (let i = 0; i < hosts.length; i++) {
            const host = hosts[i]
            if (host && host.show) {
                host.show(volumeOsdComponent, { availableWidth: host.screen?.width ?? 0 }, { timeoutMs: 2000 })
            }
        }
    }

    // wrap the osd type in a Component so OverlayHost can instantiate it.
    // why: qml types are not factory objects; createObject() lives on Component.
    Component {
        id: volumeOsdComponent

        Overlays.OsdVolume {}
    }

    NiriState {
        id: _niriState
    }

    // bind the current default sink before reading reactive audio properties.
    // why: quickshell marks volume/mute invalid unless the node is tracked.
    PwObjectTracker {
        objects: Pipewire.defaultAudioSink ? [Pipewire.defaultAudioSink] : []
    }

    Timer {
        id: volumeOsdDebounce
        interval: 60
        repeat: false
        onTriggered: root.showVolumeOsd()
    }

    QtObject {
        id: volumeWatch

        property var audio: Pipewire.defaultAudioSink?.audio ?? null
        property real lastVolume: -1
        property bool lastMuted: false
        property bool hasSnapshot: false

        function syncSnapshot(): void {
            if (!audio) {
                hasSnapshot = false
                lastVolume = -1
                lastMuted = false
                return
            }

            lastVolume = audio.volume
            lastMuted = audio.muted
            hasSnapshot = true
        }

        function handleAudioChange(): void {
            if (!audio) {
                return
            }

            const volumeChanged = !hasSnapshot || Math.abs(audio.volume - lastVolume) > 0.0001
            const mutedChanged = !hasSnapshot || audio.muted !== lastMuted

            lastVolume = audio.volume
            lastMuted = audio.muted
            hasSnapshot = true

            if (volumeChanged || mutedChanged) {
                volumeOsdDebounce.restart()
            }
        }

        onAudioChanged: syncSnapshot()
        Component.onCompleted: syncSnapshot()
    }

    Connections {
        target: volumeWatch.audio

        function onVolumeChanged(): void {
            volumeWatch.handleAudioChange()
        }

        function onMutedChanged(): void {
            volumeWatch.handleAudioChange()
        }
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

    // keep ipc for explicit callers, but source osd from pipewire changes too.
    IpcHandler {
        target: "volume"

        function showOsd(): void {
            root.showVolumeOsd()
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
