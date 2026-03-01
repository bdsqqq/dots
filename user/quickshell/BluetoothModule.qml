import Quickshell
import Quickshell.Io
import QtQuick
import QtQuick.Layouts

import "controls" as Controls
import "design" as Design
import "primitives" as Primitives

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
    implicitHeight: card.implicitHeight

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

    Primitives.Surface {
        id: card
        anchors.fill: parent
        surfaceColor: Design.Theme.t.bg
        showBorder: true

        implicitHeight: contentLayout.implicitHeight + Design.Theme.t.space3 * 2

        ColumnLayout {
            id: contentLayout
            anchors.fill: parent
            anchors.margins: Design.Theme.t.space3
            spacing: Design.Theme.t.space2

            RowLayout {
                Layout.fillWidth: true

                Primitives.T {
                    text: "bluetooth"
                    tone: "muted"
                    size: "bodySm"
                }

                Item { Layout.fillWidth: true }

                Primitives.T {
                    text: bluetoothOn ? (connectedDevice !== "" ? "connected" : "on") : "off"
                    tone: bluetoothOn ? "fg" : "subtle"
                    size: "bodySm"
                }
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: Design.Theme.t.space2

                Controls.Button {
                    variant: bluetoothOn ? "outline" : "ghost"
                    text: togglePending ? "switching..." : (bluetoothOn ? "on" : "off")
                    enabled: !togglePending
                    onClicked: {
                        togglePending = true;
                        toggleBluetooth.running = true;
                    }
                }

                Controls.Button {
                    variant: scanning ? "outline" : "ghost"
                    text: scanning ? "stop scan" : "scan"
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

                Controls.Button {
                    variant: expanded ? "outline" : "ghost"
                    text: expanded ? "hide devices" : "show devices"
                    enabled: bluetoothOn
                    onClicked: bluetoothModule.expanded = !bluetoothModule.expanded
                }
            }

            Item {
                Layout.fillWidth: true
                Layout.preferredHeight: expanded ? deviceList.implicitHeight : 0
                clip: true

                Behavior on Layout.preferredHeight {
                    NumberAnimation { duration: Design.Theme.t.durationSlow; easing.type: Easing.OutQuint }
                }

                ListView {
                    id: deviceList
                    width: parent.width
                    implicitHeight: Math.min(contentHeight, 108)
                    clip: true
                    spacing: 4
                    model: pairedDevicesModel
                    visible: bluetoothOn && pairedDevicesModel.count > 0

                    delegate: Primitives.Surface {
                        id: deviceCard
                        required property var model
                        width: deviceList.width
                        implicitHeight: deviceRow.implicitHeight + 8
                        radiusToken: "sm"
                        surfaceColor: deviceMouse.containsMouse ? Design.Theme.t.bgHover : "transparent"

                        RowLayout {
                            id: deviceRow
                            anchors.fill: parent
                            anchors.margins: 4
                            spacing: Design.Theme.t.space2

                            Primitives.T {
                                text: deviceCard.model.name
                                tone: bluetoothModule.connectedDevice === deviceCard.model.mac ? "fg" : "muted"
                                size: "bodySm"
                                elide: Text.ElideRight
                                Layout.fillWidth: true
                            }

                            Primitives.T {
                                text: bluetoothModule.connectedDevice === deviceCard.model.mac ? "connected" : "paired"
                                tone: bluetoothModule.connectedDevice === deviceCard.model.mac ? "fg" : "subtle"
                                size: "bodySm"
                            }
                        }

                        MouseArea {
                            id: deviceMouse
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                if (bluetoothModule.connectedDevice === deviceCard.model.mac) {
                                    disconnectDevice.targetMac = deviceCard.model.mac;
                                    disconnectDevice.running = true;
                                } else {
                                    connectDevice.targetMac = deviceCard.model.mac;
                                    connectDevice.running = true;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
