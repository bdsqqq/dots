import Quickshell
import Quickshell.Wayland
import Quickshell.Services.Pipewire
import QtQuick
import QtQuick.Layouts
import QtQuick.Shapes

import "controls" as Controls
import "design" as Design

PanelWindow {
    id: controlCenter

    required property var screen
    property bool isOpen: false

    readonly property int panelPadding: Design.Theme.t.space4
    readonly property int panelMargin: 0

    anchors {
        top: true
        right: true
    }

    implicitWidth: Math.min(
        screen.width,
        Math.max(contentColumn.implicitWidth + panelPadding * 2, screen.width * 0.22) + panelMargin * 2
    )
    implicitHeight: Math.min(contentColumn.implicitHeight + panelPadding * 2 + panelMargin * 2, screen.height * 0.65)

    visible: isOpen
    color: "transparent"

    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.namespace: "quickshell-control-center"

    exclusiveZone: 0

    PwObjectTracker {
        objects: [ Pipewire.defaultAudioSink ]
    }

    // panel geometry mirrors NotificationPopups: base surface + two reverse arcs.
    // why: this makes corners feel "added" from outside instead of clipping into content.
    Item {
        id: panel
        anchors.fill: parent
        anchors.margins: controlCenter.panelMargin

        readonly property int cornerRadius: Design.Theme.t.radiusMd

        Shape {
            id: topLeftReverseArc
            x: 0
            y: 0
            width: panel.cornerRadius
            height: panel.cornerRadius

            ShapePath {
                strokeWidth: -1
                fillColor: Design.Theme.t.black

                startX: panel.cornerRadius
                startY: 0

                PathLine { relativeX: 0; relativeY: panel.cornerRadius }

                PathArc {
                    relativeX: -panel.cornerRadius
                    relativeY: -panel.cornerRadius
                    radiusX: panel.cornerRadius
                    radiusY: panel.cornerRadius
                    direction: PathArc.Counterclockwise
                }
            }
        }

        Shape {
            id: bottomRightReverseArc
            x: 0
            y: 0
            width: panel.cornerRadius
            height: panel.cornerRadius

            ShapePath {
                strokeWidth: -1
                fillColor: Design.Theme.t.black

                startX: panel.width - 1
                startY: surface.height

                PathLine { relativeX: 0; relativeY: panel.cornerRadius }

                PathArc {
                    relativeX: -panel.cornerRadius
                    relativeY: -panel.cornerRadius
                    radiusX: panel.cornerRadius
                    radiusY: panel.cornerRadius
                    direction: PathArc.Counterclockwise
                }
            }
        }

        Rectangle {
            id: surface
            x: panel.cornerRadius
            y: 0
            width: panel.width - panel.cornerRadius
            height: panel.height - panel.cornerRadius
            color: Design.Theme.t.black
            topLeftRadius: 0
            topRightRadius: panel.cornerRadius
            bottomLeftRadius: panel.cornerRadius
            bottomRightRadius: 0
            clip: true

            Flickable {
            id: flickable
            anchors.fill: parent
            anchors.margins: controlCenter.panelPadding
            contentWidth: width
            contentHeight: contentColumn.implicitHeight
            clip: true
            boundsBehavior: Flickable.StopAtBounds

            ColumnLayout {
                id: contentColumn
                width: flickable.width
                spacing: Design.Theme.t.space4

                Text {
                    text: "control center"
                    color: Design.Theme.t.subtle
                    font.family: "Berkeley Mono"
                    font.pixelSize: Design.Theme.t.text2xs
                    font.weight: Font.Normal
                    Layout.fillWidth: true
                }

                ColumnLayout {
                    spacing: Design.Theme.t.space2
                    Layout.fillWidth: true

                RowLayout {
                    Layout.fillWidth: true
                    spacing: Design.Theme.t.space2

                    Text {
                        text: "volume"
                        color: Design.Theme.t.muted
                        font.family: "Berkeley Mono"
                        font.pixelSize: Design.Theme.t.bodySm
                    }

                    Item { Layout.fillWidth: true }

                    Text {
                        text: Math.round((Pipewire.defaultAudioSink?.audio.volume ?? 0) * 100) + "%"
                        color: Pipewire.defaultAudioSink?.audio.muted ? Design.Theme.t.border : Design.Theme.t.fg
                        font.family: "Berkeley Mono"
                        font.pixelSize: Design.Theme.t.bodySm

                        Behavior on color {
                            ColorAnimation { duration: Design.Theme.t.durationMed; easing.type: Easing.OutQuint }
                        }
                    }
                }

                Controls.Slider {
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

                    Controls.Button {
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
}
