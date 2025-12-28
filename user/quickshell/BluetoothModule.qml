import Quickshell
import Quickshell.Io
import QtQuick
import QtQuick.Layouts

Item {
    id: bluetoothModule

    property bool bluetoothOn: false
    property var pairedDevices: []
    property string connectedDevice: ""

    implicitWidth: parent ? parent.width : 248
    implicitHeight: Math.min(contentLayout.implicitHeight, 150)

    Process {
        id: adapterCheck
        command: ["bluetoothctl", "show"]

        stdout: SplitParser {
            onRead: function(data) {
                bluetoothModule.bluetoothOn = data.indexOf("Powered: yes") !== -1;
            }
        }
    }

    Process {
        id: devicesCheck
        command: ["bluetoothctl", "devices", "Paired"]

        property string buffer: ""

        stdout: SplitParser {
            splitMarker: ""
            onRead: function(data) {
                devicesCheck.buffer += data;
            }
        }

        onExited: function(code, status) {
            if (code === 0) {
                let devices = [];
                let lines = devicesCheck.buffer.trim().split('\n');
                for (let i = 0; i < lines.length; i++) {
                    let line = lines[i].trim();
                    let match = line.match(/^Device\s+([0-9A-Fa-f:]+)\s+(.+)$/);
                    if (match) {
                        devices.push({ mac: match[1], name: match[2] });
                    }
                }
                bluetoothModule.pairedDevices = devices;
                devicesCheck.buffer = "";
                if (devices.length > 0) {
                    checkConnectionIndex = 0;
                    checkNextConnection();
                }
            }
        }
    }

    property int checkConnectionIndex: 0

    function checkNextConnection() {
        if (checkConnectionIndex < pairedDevices.length) {
            connectionCheck.targetMac = pairedDevices[checkConnectionIndex].mac;
            connectionCheck.running = true;
        }
    }

    Process {
        id: connectionCheck
        property string targetMac: ""
        command: ["bluetoothctl", "info", targetMac]

        stdout: SplitParser {
            onRead: function(data) {
                if (data.indexOf("Connected: yes") !== -1) {
                    bluetoothModule.connectedDevice = connectionCheck.targetMac;
                }
            }
        }

        onExited: function(code, status) {
            checkConnectionIndex++;
            if (checkConnectionIndex < pairedDevices.length) {
                checkNextConnection();
            }
        }
    }

    Process {
        id: toggleBluetooth
        command: ["bluetoothctl", "power", bluetoothOn ? "off" : "on"]
        onExited: function(code, status) {
            adapterCheck.running = true;
        }
    }

    Process {
        id: connectDevice
        property string targetMac: ""
        command: ["bluetoothctl", "connect", targetMac]
        onExited: function(code, status) {
            devicesCheck.running = true;
        }
    }

    Process {
        id: disconnectDevice
        property string targetMac: ""
        command: ["bluetoothctl", "disconnect", targetMac]
        onExited: function(code, status) {
            bluetoothModule.connectedDevice = "";
            devicesCheck.running = true;
        }
    }

    Timer {
        interval: 5000
        running: true
        repeat: true
        triggeredOnStart: true
        onTriggered: {
            adapterCheck.running = true;
            devicesCheck.running = true;
        }
    }

    ColumnLayout {
        id: contentLayout
        anchors.fill: parent
        spacing: 8

        RowLayout {
            Layout.fillWidth: true
            spacing: 8

            Text {
                text: "bluetooth"
                color: "#9ca3af"
                font.family: "Berkeley Mono"
                font.pixelSize: 12
            }

            Item { Layout.fillWidth: true }

            Text {
                text: bluetoothOn ? (connectedDevice !== "" ? "connected" : "on") : "off"
                color: bluetoothOn ? "#ffffff" : "#4b5563"
                font.family: "Berkeley Mono"
                font.pixelSize: 12

                Behavior on color {
                    ColorAnimation { duration: 100; easing.type: Easing.OutQuint }
                }
            }
        }

        Rectangle {
            Layout.preferredWidth: toggleText.implicitWidth + 16
            Layout.preferredHeight: toggleText.implicitHeight + 8
            color: toggleMouse.containsMouse ? "#1f2937" : "transparent"
            border.width: 1
            border.color: bluetoothOn ? "#ffffff" : "#1f2937"
            radius: 4

            Behavior on color {
                ColorAnimation { duration: 100; easing.type: Easing.OutQuint }
            }

            Behavior on border.color {
                ColorAnimation { duration: 100; easing.type: Easing.OutQuint }
            }

            Text {
                id: toggleText
                anchors.centerIn: parent
                text: bluetoothOn ? "turn off" : "turn on"
                color: "#9ca3af"
                font.family: "Berkeley Mono"
                font.pixelSize: 11
            }

            MouseArea {
                id: toggleMouse
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                    toggleBluetooth.running = true;
                }
            }
        }

        ListView {
            id: deviceList
            Layout.fillWidth: true
            Layout.preferredHeight: Math.min(contentHeight, 80)
            clip: true
            spacing: 4
            model: bluetoothModule.pairedDevices
            visible: bluetoothOn && pairedDevices.length > 0

            delegate: Rectangle {
                width: deviceList.width
                height: deviceRow.implicitHeight + 8
                color: deviceMouse.containsMouse ? "#1f2937" : "transparent"
                radius: 4

                Behavior on color {
                    ColorAnimation { duration: 100; easing.type: Easing.OutQuint }
                }

                RowLayout {
                    id: deviceRow
                    anchors.fill: parent
                    anchors.margins: 4
                    spacing: 8

                    Text {
                        text: modelData.name
                        color: connectedDevice === modelData.mac ? "#ffffff" : "#9ca3af"
                        font.family: "Berkeley Mono"
                        font.pixelSize: 11
                        elide: Text.ElideRight
                        Layout.fillWidth: true

                        Behavior on color {
                            ColorAnimation { duration: 100; easing.type: Easing.OutQuint }
                        }
                    }

                    Text {
                        text: connectedDevice === modelData.mac ? "connected" : "paired"
                        color: connectedDevice === modelData.mac ? "#ffffff" : "#4b5563"
                        font.family: "Berkeley Mono"
                        font.pixelSize: 10

                        Behavior on color {
                            ColorAnimation { duration: 100; easing.type: Easing.OutQuint }
                        }
                    }
                }

                MouseArea {
                    id: deviceMouse
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                        if (connectedDevice === modelData.mac) {
                            disconnectDevice.targetMac = modelData.mac;
                            disconnectDevice.running = true;
                        } else {
                            connectDevice.targetMac = modelData.mac;
                            connectDevice.running = true;
                        }
                    }
                }
            }
        }
    }
}
