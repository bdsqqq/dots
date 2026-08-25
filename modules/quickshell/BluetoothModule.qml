import Quickshell
import Quickshell.Io
import QtQuick
import QtQuick.Layouts

import "controls" as Controls
import "design" as Design
import "primitives" as Primitives

Item {
    id: bluetoothModule

    property alias bluetoothOn: bluez.powered
    property alias togglePending: bluez.togglePending
    property alias connectedDevice: bluez.connectedDevice
    property alias scanning: bluez.scanning
    property bool expanded: false

    ListModel {
        id: pairedDevicesModel
    }

    implicitWidth: parent ? parent.width : 248
    implicitHeight: card.implicitHeight

    Item {
        id: bluez

        readonly property string service: "org.bluez"
        readonly property string adapterPath: "/org/bluez/hci0"
        readonly property string adapterInterface: "org.bluez.Adapter1"
        property bool powered: false
        property bool togglePending: false
        property string connectedDevice: ""
        property bool scanning: false
        property int connectionCheckIndex: 0

        function devicePath(mac) {
            return adapterPath + "/dev_" + mac.replace(/:/g, "_");
        }

        function refresh() {
            adapterPowered.running = true;
            pairedDevices.running = true;
        }

        function togglePower() {
            togglePending = true;
            setPower.running = true;
        }

        function connect(mac) {
            connectDevice.targetMac = mac;
            connectDevice.running = true;
        }

        function disconnect(mac) {
            disconnectDevice.targetMac = mac;
            disconnectDevice.running = true;
        }

        function startScan() {
            startDiscovery.running = true;
        }

        function stopScan() {
            scanTimer.running = false;
            stopDiscovery.running = true;
        }

        function checkNextConnection() {
            if (connectionCheckIndex < pairedDevicesModel.count) {
                connectedState.targetMac = pairedDevicesModel.get(connectionCheckIndex).mac;
                connectedState.running = true;
            }
        }

        Process {
            id: adapterPowered
            command: ["busctl", "get-property", bluez.service, bluez.adapterPath, bluez.adapterInterface, "Powered"]

            property string buffer: ""

            stdout: SplitParser {
                splitMarker: ""
                onRead: function(data) {
                    adapterPowered.buffer += data;
                }
            }

            onExited: function(code, status) {
                bluez.powered = code === 0 && adapterPowered.buffer.indexOf("true") !== -1;
                adapterPowered.buffer = "";
            }
        }

        Process {
            id: pairedDevices
            command: ["bash", "-lc", "for path in $(busctl tree org.bluez | sed -n 's/.*\\(\\/org\\/bluez\\/hci[0-9]\\/dev_[0-9A-Fa-f_]*\\).*/\\1/p' | sort -u); do paired=$(busctl get-property org.bluez \"$path\" org.bluez.Device1 Paired 2>/dev/null | awk '{print $2}'); [ \"$paired\" = true ] || continue; alias=$(busctl get-property org.bluez \"$path\" org.bluez.Device1 Alias 2>/dev/null | sed 's/^s \"//; s/\"$//'); mac=${path##*/dev_}; mac=${mac//_/:}; printf 'Device %s %s\\n' \"$mac\" \"$alias\"; done"]

            property string buffer: ""

            stdout: SplitParser {
                splitMarker: ""
                onRead: function(data) {
                    pairedDevices.buffer += data;
                }
            }

            onExited: function(code, status) {
                if (code === 0) {
                    let lines = pairedDevices.buffer.trim().split("\n");
                    let devices = [];
                    for (let i = 0; i < lines.length; i++) {
                        let match = lines[i].trim().match(/^Device\s+([0-9A-Fa-f:]+)\s+(.+)$/);
                        if (match) {
                            devices.push({ mac: match[1], name: match[2] });
                        }
                    }

                    pairedDevicesModel.clear();
                    bluez.connectedDevice = "";
                    for (let j = 0; j < devices.length; j++) {
                        pairedDevicesModel.append(devices[j]);
                    }

                    if (devices.length > 0) {
                        bluez.connectionCheckIndex = 0;
                        bluez.checkNextConnection();
                    }
                }
                pairedDevices.buffer = "";
            }
        }

        Process {
            id: connectedState
            property string targetMac: ""
            command: ["bash", "-lc", "path=/org/bluez/hci0/dev_${0//:/_}; busctl get-property org.bluez \"$path\" org.bluez.Device1 Connected", targetMac]

            property string buffer: ""

            stdout: SplitParser {
                splitMarker: ""
                onRead: function(data) {
                    connectedState.buffer += data;
                }
            }

            onExited: function(code, status) {
                if (code === 0 && connectedState.buffer.indexOf("true") !== -1) {
                    bluez.connectedDevice = connectedState.targetMac;
                }
                connectedState.buffer = "";
                bluez.connectionCheckIndex++;
                bluez.checkNextConnection();
            }
        }

        Process {
            id: setPower
            command: ["busctl", "set-property", bluez.service, bluez.adapterPath, bluez.adapterInterface, "Powered", "b", bluez.powered ? "false" : "true"]
            onExited: function(code, status) {
                bluez.togglePending = false;
                bluez.refresh();
            }
        }

        Process {
            id: connectDevice
            property string targetMac: ""
            command: ["bash", "-lc", "path=/org/bluez/hci0/dev_${0//:/_}; busctl call org.bluez \"$path\" org.bluez.Device1 Connect", targetMac]
            onExited: function(code, status) {
                bluez.refresh();
            }
        }

        Process {
            id: disconnectDevice
            property string targetMac: ""
            command: ["bash", "-lc", "path=/org/bluez/hci0/dev_${0//:/_}; busctl call org.bluez \"$path\" org.bluez.Device1 Disconnect", targetMac]
            onExited: function(code, status) {
                bluez.connectedDevice = "";
                bluez.refresh();
            }
        }

        Process {
            id: startDiscovery
            command: ["busctl", "call", bluez.service, bluez.adapterPath, bluez.adapterInterface, "StartDiscovery"]
            onExited: function(code, status) {
                if (code === 0) {
                    bluez.scanning = true;
                    scanTimer.running = true;
                }
            }
        }

        Process {
            id: stopDiscovery
            command: ["busctl", "call", bluez.service, bluez.adapterPath, bluez.adapterInterface, "StopDiscovery"]
            onExited: function(code, status) {
                bluez.scanning = false;
                bluez.refresh();
            }
        }

        Timer {
            id: scanTimer
            interval: 10000
            repeat: false
            onTriggered: bluez.stopScan()
        }
    }

    Timer {
        interval: 5000
        running: true
        repeat: true
        triggeredOnStart: true
        onTriggered: bluez.refresh()
    }

    Primitives.Surface {
        id: card
        anchors.fill: parent
        showBorder: true

        implicitHeight: contentLayout.implicitHeight + Design.Theme.t.space3 * 2

        ColumnLayout {
            id: contentLayout
            anchors.fill: parent
            anchors.margins: Design.Theme.t.space3
            spacing: Design.Theme.t.space2

            RowLayout {
                Layout.fillWidth: true
                Layout.preferredHeight: 32
                spacing: Design.Theme.t.space2

                Item { width: 12; Layout.fillHeight: true }

                Primitives.T {
                    text: "bluetooth"
                    tone: "muted"
                    size: "bodySm"
                    Layout.fillWidth: true
                    Layout.alignment: Qt.AlignVCenter
                }

                Controls.Button {
                    size: "sm"
                    variant: "ghost"
                    active: scanning
                    text: scanning ? "stop scan" : "scan"
                    visible: bluetoothOn
                    onClicked: scanning ? bluez.stopScan() : bluez.startScan()
                }

                Controls.Switch {
                    checked: bluetoothOn
                    disabled: togglePending
                    onToggled: bluez.togglePower()
                }

                Item { width: 12; Layout.fillHeight: true }
            }

            Controls.Accordion {
                Layout.fillWidth: true
                title: "devices"
                expanded: bluetoothModule.expanded
                disabled: !bluetoothOn
                onToggled: function(next) { bluetoothModule.expanded = next }

                ListView {
                    id: deviceList
                    Layout.fillWidth: true
                    implicitHeight: Math.min(contentHeight, 108)
                    clip: true
                    spacing: 2
                    model: pairedDevicesModel
                    visible: bluetoothOn && pairedDevicesModel.count > 0

                    delegate: Controls.MenuItem {
                        id: deviceRow
                        required property var model
                        width: deviceList.width
                        label: model.name
                        detail: bluetoothModule.connectedDevice === model.mac ? "connected" : "paired"
                        checked: bluetoothModule.connectedDevice === model.mac

                        onSelected: {
                            if (bluetoothModule.connectedDevice === model.mac) {
                                bluez.disconnect(model.mac);
                            } else {
                                bluez.connect(model.mac);
                            }
                        }
                    }
                }
            }
        }
    }
}
