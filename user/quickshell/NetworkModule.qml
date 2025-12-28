import Quickshell
import Quickshell.Io
import QtQuick
import QtQuick.Layouts

Item {
    id: networkModule

    property bool wifiEnabled: true
    property string currentSSID: "disconnected"
    property var networkList: []
    property string connectingTo: ""

    implicitWidth: parent ? parent.width : 248
    implicitHeight: Math.min(contentColumn.implicitHeight, 200)

    Process {
        id: scanNetworks
        command: ["nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY", "wifi", "list"]

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
        id: toggleWifi
        property bool enabling: true
        command: ["nmcli", "radio", "wifi", enabling ? "on" : "off"]
        onExited: function(code, status) {
            wifiEnabled = enabling;
            if (enabling) {
                pollTimer.restart();
                scanNetworks.running = true;
            } else {
                currentSSID = "disconnected";
                networkList = [];
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
            if (wifiEnabled) {
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

        RowLayout {
            Layout.fillWidth: true
            spacing: 8

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

        RowLayout {
            Layout.fillWidth: true
            spacing: 8

            Rectangle {
                Layout.preferredWidth: wifiToggleText.implicitWidth + 16
                Layout.preferredHeight: wifiToggleText.implicitHeight + 8
                color: wifiToggleMouse.containsMouse ? "#1f2937" : "transparent"
                border.width: 1
                border.color: wifiEnabled ? "#ffffff" : "#1f2937"
                radius: 4

                Behavior on color {
                    ColorAnimation { duration: 100; easing.type: Easing.OutQuint }
                }

                Behavior on border.color {
                    ColorAnimation { duration: 100; easing.type: Easing.OutQuint }
                }

                Text {
                    id: wifiToggleText
                    anchors.centerIn: parent
                    text: wifiEnabled ? "wifi on" : "wifi off"
                    color: "#9ca3af"
                    font.family: "Berkeley Mono"
                    font.pixelSize: 11
                }

                MouseArea {
                    id: wifiToggleMouse
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                        toggleWifi.enabling = !wifiEnabled;
                        toggleWifi.running = true;
                    }
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
