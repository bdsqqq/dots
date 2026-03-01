import Quickshell
import Quickshell.Io
import QtQuick
import QtQuick.Layouts

import "controls" as Controls

Item {
    id: bluetoothModule

    property bool bluetoothOn: false
    property bool togglePending: false
    property string connectedDevice: ""
    property bool expanded: false
    property bool scanning: false

    ListModel {
        id: pairedDevicesModel
    }

    implicitWidth: parent ? parent.width : 248
    implicitHeight: Math.min(contentLayout.implicitHeight, 200)

    Process {
        id: adapterCheck
        command: ["bluetoothctl", "show"]

        property string buffer: ""

        stdout: SplitParser {
            splitMarker: ""
            onRead: function(data) {
                adapterCheck.buffer += data;
            }
        }

        onExited: function(code, status) {
            bluetoothModule.bluetoothOn = adapterCheck.buffer.indexOf("Powered: yes") !== -1;
            adapterCheck.buffer = "";
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
                let lines = devicesCheck.buffer.trim().split('\n');
                let devices = [];
                for (let i = 0; i < lines.length; i++) {
                    let line = lines[i].trim();
                    if (line === "") continue;
                    let match = line.match(/^Device\s+([0-9A-Fa-f:]+)\s+(.+)$/);
                    if (match) {
                        devices.push({ mac: match[1], name: match[2] });
                    }
                }
                devicesCheck.buffer = "";
                
                pairedDevicesModel.clear();
                for (let j = 0; j < devices.length; j++) {
                    pairedDevicesModel.append(devices[j]);
                }
                
                if (devices.length > 0) {
                    checkConnectionIndex = 0;
                    checkNextConnection();
                }
            }
        }
    }

    property int checkConnectionIndex: 0

    function checkNextConnection() {
        if (checkConnectionIndex < pairedDevicesModel.count) {
            connectionCheck.targetMac = pairedDevicesModel.get(checkConnectionIndex).mac;
            connectionCheck.running = true;
        }
    }

    Process {
        id: connectionCheck
        property string targetMac: ""
        command: ["bluetoothctl", "info", targetMac]

        property string buffer: ""

        stdout: SplitParser {
            splitMarker: ""
            onRead: function(data) {
                connectionCheck.buffer += data;
            }
        }

        onExited: function(code, status) {
            if (connectionCheck.buffer.indexOf("Connected: yes") !== -1) {
                bluetoothModule.connectedDevice = connectionCheck.targetMac;
            }
            connectionCheck.buffer = "";
            checkConnectionIndex++;
            if (checkConnectionIndex < pairedDevicesModel.count) {
                checkNextConnection();
            }
        }
    }

    Process {
        id: toggleBluetooth
        command: ["bluetoothctl", "power", bluetoothOn ? "off" : "on"]
        onExited: function(code, status) {
            togglePending = false;
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

    Process {
        id: scanOn
        command: ["bluetoothctl", "scan", "on"]
        onExited: function(code, status) {
            if (code === 0) {
                bluetoothModule.scanning = true;
                scanTimer.running = true;
            }
        }
    }

    Process {
        id: scanOff
        command: ["bluetoothctl", "scan", "off"]
        onExited: function(code, status) {
            bluetoothModule.scanning = false;
            devicesCheck.running = true;
        }
    }

    Timer {
        id: scanTimer
        interval: 10000
        repeat: false
        onTriggered: {
            scanOff.running = true;
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

        Item {
            Layout.fillWidth: true
            Layout.preferredHeight: headerRow.implicitHeight

            RowLayout {
                id: headerRow
                anchors.fill: parent
                spacing: 8

                Text {
                    text: expanded ? "▾" : "▸"
                    color: "#4b5563"
                    font.family: "Berkeley Mono"
                    font.pixelSize: 10
                }

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

            MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                    bluetoothModule.expanded = !bluetoothModule.expanded;
                }
            }
        }

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 8
            visible: expanded

            Controls.Button {
                variant: bluetoothOn ? "outline" : "ghost"
                text: togglePending ? "switching..." : (bluetoothOn ? "turn off" : "turn on")
                enabled: !togglePending
                onClicked: {
                    togglePending = true;
                    toggleBluetooth.running = true;
                }
            }

            Controls.Button {
                variant: scanning ? "outline" : "ghost"
                text: scanning ? "scanning..." : "scan"
                visible: bluetoothOn
                onClicked: {
                    if (scanning) {
                        scanTimer.running = false;
                        scanOff.running = true;
                    } else {
                        scanOn.running = true;
                    }
                }
            }

            ListView {
                id: deviceList
                Layout.fillWidth: true
                Layout.preferredHeight: Math.min(contentHeight, 80)
                clip: true
                spacing: 4
                model: pairedDevicesModel
                visible: bluetoothOn && pairedDevicesModel.count > 0

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
                            text: model.name
                            color: connectedDevice === model.mac ? "#ffffff" : "#9ca3af"
                            font.family: "Berkeley Mono"
                            font.pixelSize: 11
                            elide: Text.ElideRight
                            Layout.fillWidth: true

                            Behavior on color {
                                ColorAnimation { duration: 100; easing.type: Easing.OutQuint }
                            }
                        }

                        Text {
                            text: connectedDevice === model.mac ? "connected" : "paired"
                            color: connectedDevice === model.mac ? "#ffffff" : "#4b5563"
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
                            if (connectedDevice === model.mac) {
                                disconnectDevice.targetMac = model.mac;
                                disconnectDevice.running = true;
                            } else {
                                connectDevice.targetMac = model.mac;
                                connectDevice.running = true;
                            }
                        }
                    }
                }
            }
        }
    }
}
