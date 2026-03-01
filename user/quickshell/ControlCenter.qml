import Quickshell
import Quickshell.Wayland
import Quickshell.Services.Pipewire
import QtQuick
import QtQuick.Layouts

import "./controls/Slider.qml" as ControlsSlider
import "./controls/Button.qml" as ControlsButton

PanelWindow {
    id: controlCenter

    required property var screen
    property bool isOpen: false

    anchors {
        top: true
        right: true
    }

    margins.top: 8
    margins.right: 8

    implicitWidth: 280
    implicitHeight: Math.min(contentColumn.implicitHeight + 32, screen.height * 0.6)

    visible: isOpen
    color: "transparent"

    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.namespace: "quickshell-control-center"

    exclusiveZone: 0

    PwObjectTracker {
        objects: [ Pipewire.defaultAudioSink ]
    }

    Rectangle {
        anchors.fill: parent
        color: "#000000"
        radius: 8
        clip: true

        Flickable {
            id: flickable
            anchors.fill: parent
            anchors.margins: 16
            contentWidth: width
            contentHeight: contentColumn.implicitHeight
            clip: true
            boundsBehavior: Flickable.StopAtBounds

            ColumnLayout {
                id: contentColumn
                width: flickable.width
                spacing: 16

            Text {
                text: "control center"
                color: "#6b7280"
                font.family: "Berkeley Mono"
                font.pixelSize: 11
                font.weight: Font.Normal
                Layout.fillWidth: true
            }

            ColumnLayout {
                spacing: 8
                Layout.fillWidth: true

                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8

                    Text {
                        text: "volume"
                        color: "#9ca3af"
                        font.family: "Berkeley Mono"
                        font.pixelSize: 12
                    }

                    Item { Layout.fillWidth: true }

                    Text {
                        text: Math.round((Pipewire.defaultAudioSink?.audio.volume ?? 0) * 100) + "%"
                        color: Pipewire.defaultAudioSink?.audio.muted ? "#4b5563" : "#ffffff"
                        font.family: "Berkeley Mono"
                        font.pixelSize: 12

                        Behavior on color {
                            ColorAnimation { duration: 100; easing.type: Easing.OutQuint }
                        }
                    }
                }

                ControlsSlider {
                    Layout.fillWidth: true
                    value: Pipewire.defaultAudioSink?.audio.volume ?? 0
                    enabled: Pipewire.defaultAudioSink?.audio !== null
                    onChangeEnd: function(val) {
                        if (Pipewire.defaultAudioSink?.audio) {
                            Pipewire.defaultAudioSink.audio.volume = val;
                        }
                    }
                }

                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8

                    ControlsButton {
                        variant: Pipewire.defaultAudioSink?.audio.muted ? "outline" : "ghost"
                        text: Pipewire.defaultAudioSink?.audio.muted ? "unmute" : "mute"
                        onClicked: function() {
                            if (Pipewire.defaultAudioSink?.audio) {
                                Pipewire.defaultAudioSink.audio.muted = !Pipewire.defaultAudioSink.audio.muted;
                            }
                        }
                    }

                    Item { Layout.fillWidth: true }
                }

                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 4

                    Text {
                        text: "output"
                        color: "#6b7280"
                        font.family: "Berkeley Mono"
                        font.pixelSize: 11
                    }

                    Repeater {
                        model: Pipewire.nodes

                        Rectangle {
                            id: sinkItem
                            required property PwNode modelData
                            visible: modelData.isSink && modelData.audio && !modelData.isStream
                            Layout.fillWidth: true
                            Layout.preferredHeight: visible ? sinkText.implicitHeight + 12 : 0
                            color: sinkMouse.containsMouse ? "#1f2937" : "transparent"
                            border.width: 1
                            border.color: modelData === Pipewire.defaultAudioSink ? "#ffffff" : "#1f2937"
                            radius: 4

                            Behavior on color {
                                ColorAnimation { duration: 100; easing.type: Easing.OutQuint }
                            }

                            Behavior on border.color {
                                ColorAnimation { duration: 100; easing.type: Easing.OutQuint }
                            }

                            Text {
                                id: sinkText
                                anchors.left: parent.left
                                anchors.right: parent.right
                                anchors.verticalCenter: parent.verticalCenter
                                anchors.margins: 8
                                text: modelData.nickname || modelData.description || modelData.name || "unknown"
                                color: modelData === Pipewire.defaultAudioSink ? "#ffffff" : "#9ca3af"
                                font.family: "Berkeley Mono"
                                font.pixelSize: 11
                                elide: Text.ElideRight
                            }

                            MouseArea {
                                id: sinkMouse
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: {
                                    Pipewire.preferredDefaultAudioSink = sinkItem.modelData;
                                }
                            }
                        }
                    }
                }
            }

            Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: 1
                color: "#1f2937"
            }

            BrightnessModule {
                Layout.fillWidth: true
            }

            Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: 1
                color: "#1f2937"
            }

            NetworkModule {
                Layout.fillWidth: true
            }

            Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: 1
                color: "#1f2937"
            }

            BluetoothModule {
                Layout.fillWidth: true
            }

            Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: 1
                color: "#1f2937"
            }

            BatteryModule {
                Layout.fillWidth: true
            }
            }
        }
    }
}
