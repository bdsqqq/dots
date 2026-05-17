import Quickshell
import Quickshell.Io
import QtQuick
import QtQuick.Layouts

import "controls" as Controls
import "design" as Design
import "primitives" as Primitives

Item {
    id: batteryModule

    property int batteryPercent: 0
    property string batteryStatus: "unknown"
    property real powerDraw: 0.0
    property string currentGpuProfile: "auto"
    property int currentTdp: 15
    property bool expanded: false

    implicitHeight: card.implicitHeight
    Layout.fillWidth: true

    Process {
        id: batteryReader
        command: ["cat", "/sys/class/power_supply/BAT0/capacity", "/sys/class/power_supply/BAT0/status", "/sys/class/power_supply/BAT0/power_now"]

        property string buffer: ""

        stdout: SplitParser {
            splitMarker: ""
            onRead: function(data) {
                batteryReader.buffer += data;
            }
        }

        onExited: function(code, status) {
            if (code === 0) {
                let lines = batteryReader.buffer.trim().split("\n");
                if (lines.length >= 2) {
                    batteryPercent = parseInt(lines[0]) || 0;
                    batteryStatus = lines[1].toLowerCase();
                    if (lines.length >= 3) {
                        let powerMicrowatts = parseInt(lines[2]) || 0;
                        powerDraw = powerMicrowatts / 1000000.0;
                    }
                }
            }
            batteryReader.buffer = "";
        }
    }

    Process {
        id: gpuProfileReader
        command: ["cat", "/sys/class/drm/card1/device/power_dpm_force_performance_level"]

        stdout: SplitParser {
            onRead: function(data) {
                currentGpuProfile = data.trim();
            }
        }
    }

    Process {
        id: gpuProfileSetter
        property string targetProfile: "auto"
        command: ["systemctl", "start", "amdgpu-profile@" + targetProfile + ".service"]

        onExited: function(code, status) {
            gpuProfileReader.running = true;
        }
    }

    Process {
        id: tdpSetter
        property int targetTdp: 15
        command: ["systemctl", "start", "ryzenadj-tdp@" + targetTdp + ".service"]

        onExited: function(code, status) {
            currentTdp = targetTdp;
        }
    }

    Timer {
        interval: 5000
        running: true
        repeat: true
        triggeredOnStart: true
        onTriggered: {
            batteryReader.running = true;
            gpuProfileReader.running = true;
        }
    }

    function batteryIcon(percent, status) {
        if (status === "charging") return "⚡";
        if (status === "full") return "█";
        if (percent >= 80) return "█";
        if (percent >= 60) return "▓";
        if (percent >= 40) return "▒";
        if (percent >= 20) return "░";
        return "▁";
    }

    function statusColor(percent, status) {
        if (status === "charging" || status === "full") return "#ffffff";
        if (percent <= 10) return "#ef4444";
        if (percent <= 20) return "#f97316";
        return "#ffffff";
    }

    Primitives.Surface {
        id: card
        anchors.fill: parent
        showBorder: true

        implicitHeight: contentColumn.implicitHeight + Design.Theme.t.space3 * 2

        ColumnLayout {
            id: contentColumn
            anchors.fill: parent
            anchors.margins: Design.Theme.t.space3
            spacing: Design.Theme.t.space2

            RowLayout {
                Layout.fillWidth: true
                Layout.preferredHeight: 32
                spacing: Design.Theme.t.space2

                Item { width: 12; Layout.fillHeight: true }

                Primitives.T {
                    text: "power"
                    tone: "muted"
                    size: "bodySm"
                    Layout.alignment: Qt.AlignVCenter
                }

                Primitives.T {
                    text: batteryStatus
                    tone: "subtle"
                    size: "bodySm"
                    elide: Text.ElideRight
                    Layout.fillWidth: true
                    Layout.alignment: Qt.AlignVCenter
                }

                Primitives.T {
                    text: powerDraw > 0 ? "drain " + powerDraw.toFixed(1) + "W" : ""
                    tone: "subtle"
                    size: "bodySm"
                    visible: powerDraw > 0
                    Layout.alignment: Qt.AlignVCenter
                }

                Primitives.T {
                    text: batteryPercent + "%"
                    tone: "fg"
                    size: "bodySm"
                    Layout.alignment: Qt.AlignVCenter
                }

                Item { width: 12; Layout.fillHeight: true }
            }

            Controls.Accordion {
                Layout.fillWidth: true
                title: "performance"
                detail: currentTdp + "W · " + currentGpuProfile
                expanded: batteryModule.expanded
                onToggled: function(next) { batteryModule.expanded = next }

                ColumnLayout {
                    id: expandedContentColumn
                    Layout.fillWidth: true
                    spacing: Design.Theme.t.space3

                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: Design.Theme.t.space1

                        Item {
                            Layout.fillWidth: true
                            implicitHeight: 24

                            Primitives.T {
                                anchors.left: parent.left
                                anchors.verticalCenter: parent.verticalCenter
                                text: "apu limit"
                                tone: "subtle"
                                size: "bodySm"
                            }
                        }

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: Design.Theme.t.space2

                            Repeater {
                                model: [
                                    { watts: 8, label: "8W" },
                                    { watts: 15, label: "15W" },
                                    { watts: 25, label: "25W" },
                                    { watts: 30, label: "30W" }
                                ]

                                Controls.Button {
                                    required property var modelData
                                    size: "sm"
                                    variant: "ghost"
                                    active: currentTdp === modelData.watts
                                    text: modelData.label
                                    onClicked: {
                                        if (currentTdp !== modelData.watts) {
                                            tdpSetter.targetTdp = modelData.watts;
                                            tdpSetter.running = true;
                                        }
                                    }
                                }
                            }
                        }
                    }

                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: Design.Theme.t.space1

                        Item {
                            Layout.fillWidth: true
                            implicitHeight: 24

                            Primitives.T {
                                anchors.left: parent.left
                                anchors.verticalCenter: parent.verticalCenter
                                text: "gpu mode"
                                tone: "subtle"
                                size: "bodySm"
                            }
                        }

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: Design.Theme.t.space2

                            Repeater {
                                model: [
                                    { id: "low", label: "low" },
                                    { id: "auto", label: "auto" },
                                    { id: "high", label: "high" }
                                ]

                                Controls.Button {
                                    required property var modelData
                                    size: "sm"
                                    variant: "ghost"
                                    active: currentGpuProfile === modelData.id
                                    text: modelData.label
                                    onClicked: {
                                        if (currentGpuProfile !== modelData.id) {
                                            gpuProfileSetter.targetProfile = modelData.id;
                                            gpuProfileSetter.running = true;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
