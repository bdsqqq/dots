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
        surfaceColor: Design.Theme.t.bg
        showBorder: true

        implicitHeight: contentColumn.implicitHeight + Design.Theme.t.space3 * 2

        ColumnLayout {
            id: contentColumn
            anchors.fill: parent
            anchors.margins: Design.Theme.t.space3
            spacing: Design.Theme.t.space2

            RowLayout {
                Layout.fillWidth: true

                Primitives.T {
                    text: "wifi"
                    tone: "muted"
                    size: "bodySm"
                }

                Item { Layout.fillWidth: true }

                Primitives.T {
                    text: wifiEnabled ? currentSSID : "off"
                    tone: (wifiEnabled && currentSSID !== "disconnected") ? "fg" : "subtle"
                    size: "bodySm"
                    elide: Text.ElideRight
                    horizontalAlignment: Text.AlignRight
                }
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: Design.Theme.t.space2

                Controls.Button {
                    variant: wifiEnabled ? "outline" : "ghost"
                    text: wifiTogglePending ? "switching..." : (wifiEnabled ? "on" : "off")
                    enabled: !wifiTogglePending
                    onClicked: {
                        wifiTogglePending = true;
                        toggleWifi.enabling = !wifiEnabled;
                        toggleWifi.running = true;
                    }
                }

                Controls.Button {
                    variant: expanded ? "outline" : "ghost"
                    text: expanded ? "hide" : "networks"
                    enabled: wifiEnabled
                    onClicked: expanded = !expanded
                }

                Item { Layout.fillWidth: true }
            }

            Item {
                Layout.fillWidth: true
                Layout.preferredHeight: expanded ? Math.max(networkListContainer.implicitHeight, scanStatus.implicitHeight) : 0
                clip: true

                Behavior on Layout.preferredHeight {
                    NumberAnimation { duration: Design.Theme.t.durationSlow; easing.type: Easing.OutQuint }
                }

                ColumnLayout {
                    id: networkListContainer
                    width: parent.width
                    spacing: Design.Theme.t.space2

                    Primitives.Surface {
                        Layout.fillWidth: true
                        implicitHeight: Math.min(networkListView.contentHeight + Design.Theme.t.space2, 132)
                        radiusToken: "sm"
                        surfaceColor: Design.Theme.t.inactive
                        visible: wifiEnabled && networkList.length > 0

                        ListView {
                            id: networkListView
                            anchors.fill: parent
                            anchors.margins: Design.Theme.t.space1
                            model: networkList
                            clip: true
                            spacing: 2

                            delegate: Primitives.Surface {
                                id: delegateCard
                                required property var modelData
                                width: networkListView.width
                                implicitHeight: networkRow.implicitHeight + 6
                                radiusToken: "sm"
                                surfaceColor: delegateMouse.containsMouse ? Design.Theme.t.bgHover : "transparent"

                                RowLayout {
                                    id: networkRow
                                    anchors.fill: parent
                                    anchors.margins: 4
                                    spacing: Design.Theme.t.space2

                                    Primitives.T {
                                        text: networkModule.connectingTo === delegateCard.modelData.ssid ? "connecting..." : delegateCard.modelData.ssid
                                        tone: networkModule.currentSSID === delegateCard.modelData.ssid ? "fg" : "muted"
                                        size: "bodySm"
                                        elide: Text.ElideRight
                                        Layout.fillWidth: true
                                    }

                                    Primitives.T {
                                        text: signalIcon(modelData.signal)
                                        tone: "subtle"
                                        size: "bodySm"
                                    }
                                }

                                MouseArea {
                                    id: delegateMouse
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    cursorShape: Qt.PointingHandCursor
                                    onClicked: {
                                        if (networkModule.currentSSID !== delegateCard.modelData.ssid && networkModule.connectingTo === "") {
                                            networkModule.connectingTo = delegateCard.modelData.ssid;
                                            connectNetwork.targetSSID = delegateCard.modelData.ssid;
                                            connectNetwork.running = true;
                                        }
                                    }
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
