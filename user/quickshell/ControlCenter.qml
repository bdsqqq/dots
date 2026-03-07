import Quickshell
import Quickshell.Wayland
import Quickshell.Services.Pipewire
import QtQuick
import QtQuick.Layouts
import QtQuick.Shapes

import "controls" as Controls
import "design" as Design
import "primitives" as Primitives

PanelWindow {
    id: controlCenter

    required property var screen
    property bool isOpen: false

    readonly property int panelPadding: Design.Theme.t.space4
    readonly property int panelMargin: 0
    readonly property int oneColumnMinWidth: 320
    readonly property int twoColumnMinWidth: 560
    readonly property int panelMaxHeightPadding: Design.Theme.t.space6
    readonly property bool canUseTwoColumns: screen.width >= twoColumnMinWidth + panelPadding * 2 + panelMargin * 2

    anchors {
        top: true
        right: true
    }

    implicitWidth: Math.min(
        screen.width,
        Math.max(
            contentColumn.implicitWidth + panelPadding * 2,
            (canUseTwoColumns ? twoColumnMinWidth : oneColumnMinWidth) + panelPadding * 2
        ) + panelMargin * 2
    )
    // surface loses `cornerRadius` height to preserve the bottom-right concave join.
    // compensate here so last card content doesn't get clipped.
    implicitHeight: Math.min(contentColumn.implicitHeight + panelPadding * 2 + panelMargin * 2 + Design.Theme.t.radiusMd, screen.height - panelMaxHeightPadding)

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

                // ia pass (macos-inspired, not visual mimic):
                // - connectivity cards: wifi + bluetooth
                // - media/display cards: sound + brightness
                // - status/performance card: battery + tdp/gpu detail
                Primitives.T {
                    text: "control center"
                    tone: "subtle"
                    size: "bodySm"
                    Layout.fillWidth: true
                }

                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: Design.Theme.t.space2

                    NetworkModule {
                        Layout.fillWidth: true
                    }

                    BluetoothModule {
                        Layout.fillWidth: true
                    }

                    Primitives.Surface {
                        Layout.fillWidth: true
                        surfaceColor: Design.Theme.t.bg
                        showBorder: true
                        implicitHeight: volumeContent.implicitHeight + Design.Theme.t.space3 * 2

                        ColumnLayout {
                            id: volumeContent
                            anchors.fill: parent
                            anchors.margins: Design.Theme.t.space3
                            spacing: Design.Theme.t.space2

                            RowLayout {
                                Layout.fillWidth: true

                                Primitives.T {
                                    text: "sound"
                                    tone: "muted"
                                    size: "bodySm"
                                }

                                Item { Layout.fillWidth: true }

                                Primitives.T {
                                    text: Math.round((Pipewire.defaultAudioSink?.audio.volume ?? 0) * 100) + "%"
                                    tone: Pipewire.defaultAudioSink?.audio.muted ? "subtle" : "fg"
                                    size: "bodySm"
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
                                spacing: Design.Theme.t.space2

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

                            Primitives.T {
                                text: "output"
                                tone: "subtle"
                                size: "bodySm"
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 2

                                Repeater {
                                    model: Pipewire.nodes

                                    Primitives.Surface {
                                        id: sinkItem
                                        required property PwNode modelData
                                        visible: modelData.isSink && modelData.audio && !modelData.isStream
                                        Layout.fillWidth: true
                                        implicitHeight: visible ? sinkText.implicitHeight + Design.Theme.t.space2 + 2 : 0
                                        radiusToken: "sm"
                                        surfaceColor: sinkMouse.containsMouse ? Design.Theme.t.bgHover : "transparent"
                                        showBorder: modelData === Pipewire.defaultAudioSink

                                        Primitives.T {
                                            id: sinkText
                                            anchors.left: parent.left
                                            anchors.right: parent.right
                                            anchors.verticalCenter: parent.verticalCenter
                                            anchors.margins: Design.Theme.t.space2
                                            text: sinkItem.modelData.nickname || sinkItem.modelData.description || sinkItem.modelData.name || "unknown"
                                            tone: sinkItem.modelData === Pipewire.defaultAudioSink ? "fg" : "muted"
                                            size: "bodySm"
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
                    }

                    BrightnessModule {
                        Layout.fillWidth: true
                    }

                    BatteryModule {
                        Layout.fillWidth: true
                    }

                    Item {
                        Layout.fillWidth: true
                        Layout.preferredHeight: panel.cornerRadius + Design.Theme.t.space1
                    }
                }
            }
        }
    }
}
}
