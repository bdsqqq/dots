import Quickshell
import Quickshell.Io
import QtQuick
import QtQuick.Layouts
import "controls" as Controls
import "design" as Design

Item {
    id: brightnessModule

    property real brightness: 0.5

    implicitHeight: content.implicitHeight
    Layout.fillWidth: true

    Process {
        id: brightnessReader
        command: ["brightnessctl", "-m"]

        stdout: SplitParser {
            onRead: function (data) {
                let parts = data.trim().split(",");
                if (parts.length >= 4) {
                    let percent = parseInt(parts[3].replace("%", ""));
                    brightnessModule.brightness = percent / 100;
                }
            }
        }
    }

    Process {
        id: brightnessSetter
        property int targetPercent: 50
        command: ["brightnessctl", "set", targetPercent + "%"]
    }

    Timer {
        interval: 2000
        running: true
        repeat: true
        triggeredOnStart: true
        onTriggered: brightnessReader.running = true
    }

    ColumnLayout {
        id: content
        anchors.fill: parent
        spacing: 8

        RowLayout {
            Layout.fillWidth: true
            spacing: 8

            Text {
                text: "brightness"
                color: Design.Theme.t.muted
                font.family: "Berkeley Mono"
                font.pixelSize: 12
            }

            Item {
                Layout.fillWidth: true
            }

            Text {
                text: Math.round(brightnessModule.brightness * 100) + "%"
                color: Design.Theme.t.fg
                font.family: "Berkeley Mono"
                font.pixelSize: 12
            }
        }

        Controls.Slider {
            id: slider
            Layout.fillWidth: true
            value: brightnessModule.brightness
            onChangeEnd: function (val) {
                // optimistic local sync: avoid visual rollback while brightnessctl
                // roundtrip catches up to polled state.
                brightnessModule.brightness = val;
                brightnessSetter.targetPercent = Math.round(val * 100);
                brightnessSetter.running = true;
            }
        }
    }
}
