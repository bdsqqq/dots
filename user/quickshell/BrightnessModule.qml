import Quickshell
import Quickshell.Io
import QtQuick
import QtQuick.Layouts

Item {
    id: brightnessModule

    property real brightness: 0.5

    implicitHeight: content.implicitHeight
    Layout.fillWidth: true

    Process {
        id: brightnessReader
        command: ["brightnessctl", "-m"]

        stdout: SplitParser {
            onRead: function(data) {
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
                color: "#9ca3af"
                font.family: "Berkeley Mono"
                font.pixelSize: 12
            }

            Item { Layout.fillWidth: true }

            Text {
                text: Math.round(brightnessModule.brightness * 100) + "%"
                color: "#ffffff"
                font.family: "Berkeley Mono"
                font.pixelSize: 12
            }
        }

        Rectangle {
            id: sliderTrack
            Layout.fillWidth: true
            Layout.preferredHeight: 24
            color: "#1f2937"
            radius: 4

            Rectangle {
                id: sliderFill
                width: parent.width * brightnessModule.brightness
                height: parent.height
                color: "#ffffff"
                radius: 4

                Behavior on width {
                    NumberAnimation { duration: 50; easing.type: Easing.OutQuint }
                }
            }

            MouseArea {
                id: sliderMouse
                anchors.fill: parent
                hoverEnabled: true

                onPressed: function(mouse) {
                    let newBrightness = Math.max(0.01, Math.min(1, mouse.x / width));
                    brightnessModule.brightness = newBrightness;
                    brightnessSetter.targetPercent = Math.round(newBrightness * 100);
                    brightnessSetter.running = true;
                }

                onPositionChanged: function(mouse) {
                    if (pressed) {
                        let newBrightness = Math.max(0.01, Math.min(1, mouse.x / width));
                        brightnessModule.brightness = newBrightness;
                        brightnessSetter.targetPercent = Math.round(newBrightness * 100);
                        brightnessSetter.running = true;
                    }
                }
            }
        }
    }
}
