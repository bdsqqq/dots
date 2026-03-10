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

    Primitives.Surface {
        id: card
        anchors.fill: parent
        surfaceColor: Design.Theme.t.bg
        showBorder: true

        implicitHeight: content.implicitHeight + Design.Theme.t.space3 * 2

        ColumnLayout {
            id: content
            anchors.fill: parent
            anchors.margins: Design.Theme.t.space3
            spacing: Design.Theme.t.space2

            RowLayout {
                Layout.fillWidth: true

                Primitives.T {
                    text: "display"
                    tone: "muted"
                    size: "bodySm"
                }

                Item { Layout.fillWidth: true }

                Primitives.T {
                    text: Math.round(brightnessModule.brightness * 100) + "%"
                    tone: "fg"
                    size: "bodySm"
                }
            }

            Controls.Slider {
                id: slider
                Layout.fillWidth: true
                minimumValue: 0.05
                value: brightnessModule.brightness
                onChangeEnd: function (val) {
                    brightnessModule.brightness = val;
                    brightnessSetter.targetPercent = Math.round(val * 100);
                    brightnessSetter.running = true;
                }
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: Design.Theme.t.space2

                Repeater {
                    model: [25, 50, 75, 100]

                    Controls.Button {
                        required property int modelData
                        variant: Math.abs(Math.round(brightnessModule.brightness * 100) - modelData) <= 5 ? "outline" : "ghost"
                        text: modelData + "%"
                        onClicked: {
                            const target = modelData / 100;
                            brightnessModule.brightness = target;
                            brightnessSetter.targetPercent = modelData;
                            brightnessSetter.running = true;
                        }
                    }
                }
            }
        }
    }
}
