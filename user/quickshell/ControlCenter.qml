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
    property bool soundOutputExpanded: false

    readonly property int panelPadding: Design.Theme.t.space4
    readonly property int panelVerticalPadding: 0
    readonly property int panelTopGap: Design.Theme.t.space2
    readonly property int panelMargin: 0
    readonly property int oneColumnMinWidth: 320
    readonly property int twoColumnMinWidth: 560
    readonly property int panelMaxHeightPadding: 0
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
    implicitHeight: screen.height

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
                fillColor: "transparent"

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
                fillColor: "transparent"

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
            height: panel.height
            color: "transparent"
            topLeftRadius: 0
            topRightRadius: panel.cornerRadius
            bottomLeftRadius: panel.cornerRadius
            bottomRightRadius: 0
            clip: true

            Flickable {
            id: flickable
            anchors.fill: parent
            anchors.leftMargin: controlCenter.panelPadding
            anchors.rightMargin: controlCenter.panelPadding
            anchors.topMargin: controlCenter.panelVerticalPadding
            anchors.bottomMargin: controlCenter.panelVerticalPadding
            contentWidth: width
            contentHeight: contentColumn.implicitHeight + controlCenter.panelTopGap
            clip: true
            boundsBehavior: Flickable.StopAtBounds

            ColumnLayout {
                id: contentColumn
                y: controlCenter.panelTopGap
                width: flickable.width
                spacing: Design.Theme.t.space4

                // ia pass (macos-inspired, not visual mimic):
                // - connectivity cards: wifi + bluetooth
                // - media/display cards: sound + brightness
                // - status/performance card: battery + tdp/gpu detail
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
                        showBorder: true
                        implicitHeight: volumeContent.implicitHeight + Design.Theme.t.space3 * 2

                        ColumnLayout {
                            id: volumeContent
                            anchors.fill: parent
                            anchors.margins: Design.Theme.t.space3
                            spacing: Design.Theme.t.space2

                            RowLayout {
                                Layout.fillWidth: true
                                Layout.preferredHeight: 32
                                spacing: Design.Theme.t.space2

                                Item { width: 12; Layout.fillHeight: true }

                                Primitives.T {
                                    text: "sound"
                                    tone: "muted"
                                    size: "bodySm"
                                    Layout.alignment: Qt.AlignVCenter
                                }

                                Primitives.T {
                                    text: Math.round(Math.max(0, Math.min(1, Pipewire.defaultAudioSink?.audio.volume ?? 0)) * 100) + "%"
                                    tone: Pipewire.defaultAudioSink?.audio.muted ? "subtle" : "fg"
                                    size: "bodySm"
                                    horizontalAlignment: Text.AlignRight
                                    Layout.fillWidth: true
                                    Layout.alignment: Qt.AlignVCenter
                                }

                                Controls.Switch {
                                    checked: !(Pipewire.defaultAudioSink?.audio.muted ?? true)
                                    disabled: Pipewire.defaultAudioSink?.audio === null
                                    onToggled: function(next) {
                                        if (Pipewire.defaultAudioSink?.audio) {
                                            Pipewire.defaultAudioSink.audio.muted = !next;
                                        }
                                    }
                                }

                                Item { width: 12; Layout.fillHeight: true }
                            }

                            Controls.Slider {
                                Layout.fillWidth: true
                                value: Math.max(0, Math.min(1, Pipewire.defaultAudioSink?.audio.volume ?? 0))
                                enabled: Pipewire.defaultAudioSink?.audio !== null
                                onChangeEnd: function(val) {
                                    if (Pipewire.defaultAudioSink?.audio) {
                                        Pipewire.defaultAudioSink.audio.volume = val;
                                    }
                                }
                            }

                            Controls.Accordion {
                                Layout.fillWidth: true
                                title: "output"
                                detail: Pipewire.defaultAudioSink?.nickname || Pipewire.defaultAudioSink?.description || Pipewire.defaultAudioSink?.name || "unknown"
                                expanded: controlCenter.soundOutputExpanded
                                onToggled: function(next) { controlCenter.soundOutputExpanded = next }

                                ColumnLayout {
                                    Layout.fillWidth: true
                                    spacing: 2

                                    Repeater {
                                        model: Pipewire.nodes

                                        Controls.MenuItem {
                                            id: sinkItem
                                            required property PwNode modelData
                                            visible: modelData.isSink && modelData.audio && !modelData.isStream
                                            Layout.fillWidth: true
                                            implicitHeight: visible ? 32 : 0
                                            label: modelData.nickname || modelData.description || modelData.name || "unknown"
                                            checked: modelData === Pipewire.defaultAudioSink

                                            onSelected: {
                                                Pipewire.preferredDefaultAudioSink = modelData;
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
