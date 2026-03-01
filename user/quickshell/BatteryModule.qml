import Quickshell
import Quickshell.Io
import QtQuick
import QtQuick.Layouts

import "controls" as Controls

Item {
    id: batteryModule

    property int batteryPercent: 0
    property string batteryStatus: "unknown"
    property real powerDraw: 0.0
    property string currentGpuProfile: "auto"
    property int currentTdp: 15
    property bool expanded: false

    implicitHeight: contentColumn.implicitHeight
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

    ColumnLayout {
        id: contentColumn
        anchors.fill: parent
        spacing: 8

        Item {
            Layout.fillWidth: true
            Layout.preferredHeight: headerRow.implicitHeight

            RowLayout {
                id: headerRow
                anchors.fill: parent
                spacing: 8

                Text {
                    text: expanded ? "▾" : "▸"
                    color: "#9ca3af"
                    font.family: "Berkeley Mono"
                    font.pixelSize: 12
                }

                Text {
                    text: "battery"
                    color: "#9ca3af"
                    font.family: "Berkeley Mono"
                    font.pixelSize: 12
                }

                Item { Layout.fillWidth: true }

                Text {
                    text: batteryIcon(batteryPercent, batteryStatus)
                    color: statusColor(batteryPercent, batteryStatus)
                    font.family: "Berkeley Mono"
                    font.pixelSize: 12

                    Behavior on color {
                        ColorAnimation { duration: 100; easing.type: Easing.OutQuint }
                    }
                }

                Text {
                    text: batteryPercent + "%"
                    color: statusColor(batteryPercent, batteryStatus)
                    font.family: "Berkeley Mono"
                    font.pixelSize: 12

                    Behavior on color {
                        ColorAnimation { duration: 100; easing.type: Easing.OutQuint }
                    }
                }
            }

            MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: expanded = !expanded
            }
        }

        Item {
            id: collapsibleContent
            Layout.fillWidth: true
            Layout.preferredHeight: expanded ? expandedContentColumn.implicitHeight : 0
            clip: true

            Behavior on Layout.preferredHeight {
                NumberAnimation { duration: 150; easing.type: Easing.OutQuint }
            }

            ColumnLayout {
                id: expandedContentColumn
                width: parent.width
                spacing: 8

                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8

                    Text {
                        text: batteryStatus
                        color: "#6b7280"
                        font.family: "Berkeley Mono"
                        font.pixelSize: 11
                    }

                    Item { Layout.fillWidth: true }

                    Text {
                        text: powerDraw.toFixed(1) + "W"
                        color: "#6b7280"
                        font.family: "Berkeley Mono"
                        font.pixelSize: 11
                        visible: powerDraw > 0
                    }
                }

                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 1
                    color: "#374151"
                }

                Text {
                    text: "tdp"
                    color: "#6b7280"
                    font.family: "Berkeley Mono"
                    font.pixelSize: 11
                }

                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8

                    Repeater {
                        model: [
                            { watts: 8, label: "8W" },
                            { watts: 15, label: "15W" },
                            { watts: 25, label: "25W" },
                            { watts: 30, label: "30W" }
                        ]

                        Controls.Button {
                            required property var modelData

                            variant: currentTdp === modelData.watts ? "outline" : "ghost"
                            text: modelData.label
                            onClicked: {
                                if (currentTdp !== modelData.watts) {
                                    tdpSetter.targetTdp = modelData.watts;
                                    tdpSetter.running = true;
                                }
                            }
                        }
                    }

                    Item { Layout.fillWidth: true }
                }

                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 1
                    color: "#374151"
                }

                Text {
                    text: "gpu"
                    color: "#6b7280"
                    font.family: "Berkeley Mono"
                    font.pixelSize: 11
                }

                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8

                    Repeater {
                        model: [
                            { id: "low", label: "low" },
                            { id: "auto", label: "auto" },
                            { id: "high", label: "high" }
                        ]

                        Controls.Button {
                            required property var modelData

                            variant: currentGpuProfile === modelData.id ? "outline" : "ghost"
                            text: modelData.label
                            onClicked: {
                                if (currentGpuProfile !== modelData.id) {
                                    gpuProfileSetter.targetProfile = modelData.id;
                                    gpuProfileSetter.running = true;
                                }
                            }
                        }
                    }

                    Item { Layout.fillWidth: true }
                }
            }
        }
    }
}
