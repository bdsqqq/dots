import Quickshell
import Quickshell.Io
import QtQuick
import QtQuick.Layouts

import "controls" as Controls

Item {
    id: networkModule

    property bool wifiEnabled: true
    property bool wifiTogglePending: false
    property string currentSSID: "disconnected"
    property var networkList: []
    property string connectingTo: ""
    property bool expanded: false

    implicitWidth: parent ? parent.width : 248
    implicitHeight: Math.min(contentColumn.implicitHeight, 200)

    Process {
        id: scanNetworks
        command: ["nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list"]

        property string buffer: ""

        stdout: SplitParser {
            splitMarker: ""
            onRead: function(data) {
                scanNetworks.buffer += data;
            }
        }

        onExited: function(code, status) {
            if (code === 0) {
                let lines = scanNetworks.buffer.trim().split("\n");
                let networks = [];
                let seen = {};
                for (let i = 0; i < lines.length; i++) {
                    let parts = lines[i].split(":");
                    if (parts[0] && !seen[parts[0]]) {
                        seen[parts[0]] = true;
                        networks.push({
                            ssid: parts[0],
                            signal: parseInt(parts[1]) || 0,
                            security: parts[2] || ""
                        });
                    }
                }
                networks.sort((a, b) => b.signal - a.signal);
                networkList = networks;
            }
            scanNetworks.buffer = "";
        }
    }

    Process {
        id: getActiveConnection
        command: ["nmcli", "-t", "-f", "NAME,TYPE,DEVICE", "connection", "show", "--active"]

        property string buffer: ""

        stdout: SplitParser {
            splitMarker: ""
            onRead: function(data) {
                getActiveConnection.buffer += data;
            }
        }

        onExited: function(code, status) {
            if (code === 0) {
                let lines = getActiveConnection.buffer.trim().split("\n");
                for (let i = 0; i < lines.length; i++) {
                    let parts = lines[i].split(":");
                    if (parts[1] === "802-11-wireless") {
                        currentSSID = parts[0];
                        getActiveConnection.buffer = "";
                        return;
                    }
                }
                currentSSID = "disconnected";
            }
            getActiveConnection.buffer = "";
        }
    }

    Process {
        id: wifiRadioStatus
        command: ["nmcli", "-t", "-f", "WIFI", "radio"]

        property string buffer: ""

        stdout: SplitParser {
            splitMarker: ""
            onRead: function(data) {
                wifiRadioStatus.buffer += data;
            }
        }

        onExited: function(code, status) {
            if (code === 0) {
                wifiEnabled = wifiRadioStatus.buffer.trim() === "enabled";
                if (!wifiEnabled) {
                    currentSSID = "disconnected";
                    networkList = [];
                }
            }
            wifiRadioStatus.buffer = "";
        }
    }

    Process {
        id: toggleWifi
        property bool enabling: true
        command: ["nmcli", "radio", "wifi", enabling ? "on" : "off"]
        onExited: function(code, status) {
            wifiTogglePending = false;
            wifiRadioStatus.running = true;
            if (code === 0 && enabling) {
                pollTimer.restart();
                scanNetworks.running = true;
            }
        }
    }

    Process {
        id: connectNetwork
        property string targetSSID: ""
        command: ["nmcli", "device", "wifi", "connect", targetSSID]
        onExited: function(code, status) {
            connectingTo = "";
            getActiveConnection.running = true;
        }
    }

    Timer {
        id: pollTimer
        interval: 10000
        running: true
        repeat: true
        triggeredOnStart: true
        onTriggered: {
            wifiRadioStatus.running = true;
            if (wifiEnabled && !wifiTogglePending) {
                scanNetworks.running = true;
                getActiveConnection.running = true;
            }
        }
    }

    function signalIcon(signal) {
        if (signal >= 75) return "⣿";
        if (signal >= 50) return "⣶";
        if (signal >= 25) return "⣤";
        return "⣀";
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
                    text: "network"
                    color: "#9ca3af"
                    font.family: "Berkeley Mono"
                    font.pixelSize: 12
                }

                Item { Layout.fillWidth: true }

                Text {
                    text: wifiEnabled ? currentSSID : "wifi off"
                    color: currentSSID === "disconnected" || !wifiEnabled ? "#4b5563" : "#ffffff"
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

                    Controls.Button {
                        variant: wifiEnabled ? "outline" : "ghost"
                        text: wifiTogglePending ? "switching..." : (wifiEnabled ? "wifi on" : "wifi off")
                        enabled: !wifiTogglePending
                        onClicked: {
                            wifiTogglePending = true;
                            toggleWifi.enabling = !wifiEnabled;
                            toggleWifi.running = true;
                        }
                    }

                    Item { Layout.fillWidth: true }
                }

                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: Math.min(networkListView.contentHeight, 120)
                    color: "#1f2937"
                    radius: 4
                    visible: wifiEnabled && networkList.length > 0

                    ListView {
                        id: networkListView
                        anchors.fill: parent
                        anchors.margins: 4
                        model: networkList
                        clip: true
                        spacing: 2

                        delegate: Rectangle {
                            width: networkListView.width
                            height: 24
                            color: delegateMouse.containsMouse ? "#374151" : "transparent"
                            radius: 4

                            Behavior on color {
                                ColorAnimation { duration: 100; easing.type: Easing.OutQuint }
                            }

                            RowLayout {
                                anchors.fill: parent
                                anchors.leftMargin: 8
                                anchors.rightMargin: 8
                                spacing: 8

                                Text {
                                    text: connectingTo === modelData.ssid ? "connecting..." : modelData.ssid
                                    color: currentSSID === modelData.ssid ? "#ffffff" : "#9ca3af"
                                    font.family: "Berkeley Mono"
                                    font.pixelSize: 11
                                    elide: Text.ElideRight
                                    Layout.fillWidth: true

                                    Behavior on color {
                                        ColorAnimation { duration: 100; easing.type: Easing.OutQuint }
                                    }
                                }

                                Text {
                                    text: signalIcon(modelData.signal)
                                    color: "#6b7280"
                                    font.family: "Berkeley Mono"
                                    font.pixelSize: 10
                                }
                            }

                            MouseArea {
                                id: delegateMouse
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: {
                                    if (currentSSID !== modelData.ssid && connectingTo === "") {
                                        connectingTo = modelData.ssid;
                                        connectNetwork.targetSSID = modelData.ssid;
                                        connectNetwork.running = true;
                                    }
                                }
                            }
                        }
                    }
                }

                Text {
                    visible: wifiEnabled && networkList.length === 0
                    text: "scanning..."
                    color: "#4b5563"
                    font.family: "Berkeley Mono"
                    font.pixelSize: 11
                }
            }
        }
    }
}
