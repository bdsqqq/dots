pragma ComponentBehavior: Bound

import Quickshell.Io
import QtQuick
import QtQuick.Layouts

import "controls" as Controls
import "design" as Design
import "primitives" as Primitives

Item {
    id: brightnessModule

    property real brightness: 0.5
    readonly property int minimumBrightnessPercent: 3

    implicitHeight: card.implicitHeight
    Layout.fillWidth: true

    Process {
        id: brightnessReader
        command: ["brightnessctl", "-m"]

        stdout: SplitParser {
            onRead: function (data) {
                let parts = data.trim().split(",");
                if (parts.length >= 4) {
                    let percent = parseInt(parts[3].replace("%", ""));
                    let clampedPercent = Math.max(brightnessModule.minimumBrightnessPercent, percent);
                    brightnessModule.brightness = clampedPercent / 100;
                    if (percent < brightnessModule.minimumBrightnessPercent) {
                        brightnessSetter.targetPercent = brightnessModule.minimumBrightnessPercent;
                        brightnessSetter.running = true;
                    }
                }
            }
        }
    }

    Process {
        id: brightnessSetter
        property int targetPercent: 50
        command: ["brightnessctl", "set", Math.max(brightnessModule.minimumBrightnessPercent, targetPercent) + "%"]
    }

    Timer {
        interval: 2000
        running: true
        repeat: true
        triggeredOnStart: true
        onTriggered: brightnessReader.running = true
    }

    Primitives.Surface {
        id: card
        anchors.fill: parent
        showBorder: true

        implicitHeight: content.implicitHeight + Design.Theme.t.space3 * 2

        ColumnLayout {
            id: content
            anchors.fill: parent
            anchors.margins: Design.Theme.t.space3
            spacing: Design.Theme.t.space2

            RowLayout {
                Layout.fillWidth: true
                Layout.preferredHeight: 32
                spacing: Design.Theme.t.space2

                Item { width: 12; Layout.fillHeight: true }

                Primitives.T {
                    text: "display"
                    tone: "muted"
                    size: "bodySm"
                    Layout.alignment: Qt.AlignVCenter
                }

                Primitives.T {
                    text: Math.round(brightnessModule.brightness * 100) + "%"
                    tone: "fg"
                    size: "bodySm"
                    horizontalAlignment: Text.AlignRight
                    Layout.fillWidth: true
                    Layout.alignment: Qt.AlignVCenter
                }

                Item { width: 12; Layout.fillHeight: true }
            }

            Controls.Slider {
                id: slider
                Layout.fillWidth: true
                minimumValue: brightnessModule.minimumBrightnessPercent / 100
                value: brightnessModule.brightness
                onChangeEnd: function (val) {
                    let clampedValue = Math.max(brightnessModule.minimumBrightnessPercent / 100, val);
                    brightnessModule.brightness = clampedValue;
                    brightnessSetter.targetPercent = Math.max(brightnessModule.minimumBrightnessPercent, Math.round(clampedValue * 100));
                    brightnessSetter.running = true;
                }
            }
        }
    }
}
