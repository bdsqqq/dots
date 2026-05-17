import Quickshell
import Quickshell.Io
import QtQuick
import QtQuick.Layouts

import "controls" as Controls
import "design" as Design
import "primitives" as Primitives

Item {
    id: networkModule

    property bool wifiEnabled: true
    property bool wifiTogglePending: false
    property string currentSSID: "disconnected"
    property var networkList: []
    property string connectingTo: ""
    property bool expanded: false

    implicitWidth: parent ? parent.width : 248
    implicitHeight: card.implicitHeight

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
                    text: "wifi"
                    tone: "muted"
                    size: "bodySm"
                    Layout.alignment: Qt.AlignVCenter
                }

                Primitives.T {
                    text: (wifiEnabled && currentSSID !== "disconnected") ? currentSSID : ""
                    tone: "fg"
                    size: "bodySm"
                    elide: Text.ElideRight
                    horizontalAlignment: Text.AlignRight
                    Layout.fillWidth: true
                    Layout.alignment: Qt.AlignVCenter
                }

                Controls.Switch {
                    checked: wifiEnabled
                    disabled: wifiTogglePending
                    onToggled: function(next) {
                        wifiTogglePending = true;
                        toggleWifi.enabling = next;
                        toggleWifi.running = true;
                    }
                }

                Item { width: 12; Layout.fillHeight: true }
            }

            Controls.Accordion {
                Layout.fillWidth: true
                title: "networks"
                expanded: networkModule.expanded
                disabled: !wifiEnabled
                onToggled: function(next) { networkModule.expanded = next }

                ColumnLayout {
                    id: networkListContainer
                    Layout.fillWidth: true
                    spacing: 2

                    ListView {
                        id: networkListView
                        Layout.fillWidth: true
                        implicitHeight: Math.min(contentHeight, 132)
                        model: networkList
                        clip: true
                        spacing: 2
                        visible: wifiEnabled && networkList.length > 0

                        delegate: Controls.MenuItem {
                            id: networkRow
                            required property var modelData
                            width: networkListView.width
                            label: networkModule.connectingTo === modelData.ssid ? "connecting..." : modelData.ssid
                            detail: signalIcon(modelData.signal)
                            checked: networkModule.currentSSID === modelData.ssid

                            onSelected: {
                                if (networkModule.currentSSID !== modelData.ssid && networkModule.connectingTo === "") {
                                    networkModule.connectingTo = modelData.ssid;
                                    connectNetwork.targetSSID = modelData.ssid;
                                    connectNetwork.running = true;
                                }
                            }
                        }
                    }

                    Primitives.T {
                        id: scanStatus
                        visible: wifiEnabled && networkList.length === 0
                        text: "scanning..."
                        tone: "subtle"
                        size: "bodySm"
                    }
                }
            }
        }
    }
}
