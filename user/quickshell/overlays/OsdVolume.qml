// OsdVolume.qml
// Volume overlay displaying sink status with slider.
// Why: same Slider control as ControlCenter ensures visual consistency.
//      Minimal layout optimized for quick glance during key presses.

import Quickshell
import Quickshell.Services.Pipewire
import QtQuick
import QtQuick.Layouts

import "../design" as Design
import "../controls" as Controls

Rectangle {
    id: root

    readonly property int panelPadding: Design.Theme.t.space4
    readonly property real desiredWidth: layout.implicitWidth + panelPadding * 2
    readonly property real sinkVolume: Pipewire.defaultAudioSink?.audio.volume ?? 0
    readonly property real visualVolume: Math.max(0, Math.min(1, sinkVolume))
    property real availableWidth: 0

    implicitWidth: availableWidth > 0 ? Math.min(availableWidth * 0.36, Math.max(availableWidth * 0.18, desiredWidth)) : desiredWidth
    implicitHeight: layout.implicitHeight + panelPadding * 2
    width: implicitWidth
    height: implicitHeight

    color: Design.Theme.t.black
    radius: Design.Theme.t.radiusMd

    // track sink for volume/muted updates
    PwObjectTracker {
        objects: [Pipewire.defaultAudioSink]
    }

    ColumnLayout {
        id: layout
        anchors.fill: parent
        anchors.margins: root.panelPadding
        spacing: Design.Theme.t.space2

        // header: icon + label + percentage
        RowLayout {
            Layout.fillWidth: true
            spacing: Design.Theme.t.space3

            // speaker icon (simplified using unicode for reliability)
            Text {
                text: Pipewire.defaultAudioSink?.audio.muted ? "mute" : "vol"
                color: Pipewire.defaultAudioSink?.audio.muted ? Design.Theme.t.muted : Design.Theme.t.fg
                font.family: "Berkeley Mono"
                font.pixelSize: Design.Theme.t.bodySm
            }

            Item { Layout.fillWidth: true }

            Text {
                text: Math.round(root.visualVolume * 100) + "%"
                color: Pipewire.defaultAudioSink?.audio.muted ? Design.Theme.t.muted : Design.Theme.t.fg
                font.family: "Berkeley Mono"
                font.pixelSize: Design.Theme.t.bodyMd

                Behavior on color {
                    ColorAnimation { duration: Design.Theme.t.durationMed; easing.type: Easing.OutQuint }
                }
            }
        }

        // slider: same control as ControlCenter
        Controls.Slider {
            Layout.fillWidth: true
            value: root.visualVolume
            enabled: Pipewire.defaultAudioSink?.audio !== null && !Pipewire.defaultAudioSink?.audio.muted
            onChangeEnd: function(val) {
                if (Pipewire.defaultAudioSink?.audio) {
                    Pipewire.defaultAudioSink.audio.volume = val
                }
            }
        }
    }
}
