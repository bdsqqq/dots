import QtQuick
import QtQuick.Layouts
import Quickshell.Services.Notifications

Rectangle {
    id: root

    required property Notification notification

    property int padding: 12
    property int rounding: 8

    implicitWidth: 320
    implicitHeight: contentLayout.implicitHeight + padding * 2

    color: notification.urgency === NotificationUrgency.Critical ? "#1a1a1a" : "#0a0a0a"
    radius: rounding

    ColumnLayout {
        id: contentLayout
        anchors.fill: parent
        anchors.margins: root.padding
        spacing: 4

        RowLayout {
            Layout.fillWidth: true
            spacing: 8

            Text {
                text: root.notification.appName || "notification"
                color: "#6b7280"
                font.family: "Berkeley Mono"
                font.pixelSize: 12
                elide: Text.ElideRight
                Layout.fillWidth: true
            }

            Text {
                text: "×"
                color: "#6b7280"
                font.family: "Berkeley Mono"
                font.pixelSize: 14

                MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.notification.dismiss()
                }
            }
        }

        Text {
            text: root.notification.summary
            color: "#ffffff"
            font.family: "Berkeley Mono"
            font.pixelSize: 14
            font.bold: true
            wrapMode: Text.WordWrap
            Layout.fillWidth: true
            visible: text.length > 0
        }

        Text {
            text: root.notification.body
            color: "#d1d5db"
            font.family: "Berkeley Mono"
            font.pixelSize: 13
            wrapMode: Text.WordWrap
            Layout.fillWidth: true
            visible: text.length > 0
            maximumLineCount: 4
            elide: Text.ElideRight
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.topMargin: 4
            spacing: 8
            visible: root.notification.actions.length > 0

            Repeater {
                model: root.notification.actions

                Rectangle {
                    required property NotificationAction modelData

                    implicitWidth: actionText.implicitWidth + 16
                    implicitHeight: actionText.implicitHeight + 8
                    color: actionMouse.containsMouse ? "#333333" : "#1a1a1a"
                    radius: 4

                    Text {
                        id: actionText
                        anchors.centerIn: parent
                        text: modelData.text
                        color: "#d1d5db"
                        font.family: "Berkeley Mono"
                        font.pixelSize: 12
                    }

                    MouseArea {
                        id: actionMouse
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: modelData.invoke()
                    }
                }
            }
        }
    }

    Timer {
        interval: root.notification.expireTimeout > 0 ? root.notification.expireTimeout * 1000 : 5000
        running: true
        onTriggered: root.notification.expire()
    }
}
