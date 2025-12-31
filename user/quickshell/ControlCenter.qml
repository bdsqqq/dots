import Quickshell
import Quickshell.Wayland
import Quickshell.Services.Pipewire
import QtQuick
import QtQuick.Layouts

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

                Rectangle {
                    id: sliderTrack
                    Layout.fillWidth: true
                    Layout.preferredHeight: 24
                    color: "#1f2937"
                    radius: 4

                    Rectangle {
                        id: sliderFill
                        width: parent.width * (Pipewire.defaultAudioSink?.audio.volume ?? 0)
                        height: parent.height
                        color: Pipewire.defaultAudioSink?.audio.muted ? "#4b5563" : "#ffffff"
                        radius: 4

                        Behavior on width {
                            NumberAnimation { duration: 50; easing.type: Easing.OutQuint }
                        }

                        Behavior on color {
                            ColorAnimation { duration: 100; easing.type: Easing.OutQuint }
                        }
                    }

                    MouseArea {
                        id: sliderMouse
                        anchors.fill: parent
                        hoverEnabled: true

                        onPressed: function(mouse) {
                            if (Pipewire.defaultAudioSink?.audio) {
                                Pipewire.defaultAudioSink.audio.volume = Math.max(0, Math.min(1, mouse.x / width));
                            }
                        }

                        onPositionChanged: function(mouse) {
                            if (pressed && Pipewire.defaultAudioSink?.audio) {
                                Pipewire.defaultAudioSink.audio.volume = Math.max(0, Math.min(1, mouse.x / width));
                            }
                        }
                    }
                }

                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8

                    Rectangle {
                        Layout.preferredWidth: muteText.implicitWidth + 16
                        Layout.preferredHeight: muteText.implicitHeight + 8
                        color: muteMouse.containsMouse ? "#1f2937" : "transparent"
                        border.width: 1
                        border.color: Pipewire.defaultAudioSink?.audio.muted ? "#ffffff" : "#1f2937"
                        radius: 4

                        Behavior on color {
                            ColorAnimation { duration: 100; easing.type: Easing.OutQuint }
                        }

                        Behavior on border.color {
                            ColorAnimation { duration: 100; easing.type: Easing.OutQuint }
                        }

                        Text {
                            id: muteText
                            anchors.centerIn: parent
                            text: Pipewire.defaultAudioSink?.audio.muted ? "unmute" : "mute"
                            color: "#9ca3af"
                            font.family: "Berkeley Mono"
                            font.pixelSize: 11
                        }

                        MouseArea {
                            id: muteMouse
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                if (Pipewire.defaultAudioSink?.audio) {
                                    Pipewire.defaultAudioSink.audio.muted = !Pipewire.defaultAudioSink.audio.muted;
                                }
                            }
                        }
                    }

                    Item { Layout.fillWidth: true }
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
