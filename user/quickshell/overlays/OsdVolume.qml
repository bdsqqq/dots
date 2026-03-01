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

    width: 280
    height: layout.implicitHeight + Design.Theme.t.space4 * 2

    color: Design.Theme.t.black
    radius: Design.Theme.t.radiusMd

    // track sink for volume/muted updates
    PwObjectTracker {
        objects: [Pipewire.defaultAudioSink]
    }

    ColumnLayout {
        id: layout
        anchors.fill: parent
        anchors.margins: Design.Theme.t.space4
        spacing: Design.Theme.t.space3

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
                text: Math.round((Pipewire.defaultAudioSink?.audio.volume ?? 0) * 100) + "%"
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
            value: Pipewire.defaultAudioSink?.audio.volume ?? 0
            enabled: Pipewire.defaultAudioSink?.audio !== null && !Pipewire.defaultAudioSink?.audio.muted
            onChangeEnd: function(val) {
                if (Pipewire.defaultAudioSink?.audio) {
                    Pipewire.defaultAudioSink.audio.volume = val
                }
            }
        }
    }
}
