// OsdVolume.qml
// Volume overlay displaying sink status with slider.
// Why: same Slider control as ControlCenter ensures visual consistency.
//      Minimal layout optimized for quick glance during key presses.

import Quickshell
import Quickshell.Services.Pipewire
import QtQuick
import QtQuick.Layouts

import "../design/Theme.qml" as Theme
import "../controls/Slider.qml" as SliderControl

Rectangle {
    id: root

    width: 280
    height: layout.implicitHeight + Theme.t.space4 * 2

    color: Theme.t.black
    radius: Theme.t.radius.md

    // track sink for volume/muted updates
    PwObjectTracker {
        objects: [Pipewire.defaultAudioSink]
    }

    ColumnLayout {
        id: layout
        anchors.fill: parent
        anchors.margins: Theme.t.space4
        spacing: Theme.t.space3

        // header: icon + label + percentage
        RowLayout {
            Layout.fillWidth: true
            spacing: Theme.t.space3

            // speaker icon (simplified using unicode for reliability)
            Text {
                text: Pipewire.defaultAudioSink?.audio.muted ? "mute" : "vol"
                color: Pipewire.defaultAudioSink?.audio.muted ? Theme.t.c.muted : Theme.t.c.fg
                font.family: "Berkeley Mono"
                font.pixelSize: Theme.t.type.bodySm
            }

            Item { Layout.fillWidth: true }

            Text {
                text: Math.round((Pipewire.defaultAudioSink?.audio.volume ?? 0) * 100) + "%"
                color: Pipewire.defaultAudioSink?.audio.muted ? Theme.t.c.muted : Theme.t.c.fg
                font.family: "Berkeley Mono"
                font.pixelSize: Theme.t.type.bodyMd

                Behavior on color {
                    ColorAnimation { duration: Theme.t.durationMed; easing.type: Easing.OutQuint }
                }
            }
        }

        // slider: same control as ControlCenter
        SliderControl {
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
