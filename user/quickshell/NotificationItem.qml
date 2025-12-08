import QtQuick
import QtQuick.Layouts
import Quickshell.Services.Notifications

Item {
    id: root

    required property Notification notification
    required property bool isLast

    property int padding: 16

    signal dismissed()
    signal expired()

    implicitWidth: parent.width
    implicitHeight: contentLayout.implicitHeight + padding * 2

    Rectangle {
        anchors.fill: parent
        color: "transparent"
        bottomLeftRadius: 8
        clip: true
    }

    ColumnLayout {
        id: contentLayout
        anchors.fill: parent
        anchors.margins: root.padding
        spacing: 0

        RowLayout {
            Layout.fillWidth: true
            spacing: 0

            Text {
                text: root.notification.summary || "notification"
                color: "#ffffff"
                font.family: "Berkeley Mono"
                font.pixelSize: 14
                font.weight: Font.Medium
                elide: Text.ElideRight
                Layout.fillWidth: true
            }

            Text {
                id: dismissButton
                text: "×"
                color: dismissMouse.containsMouse ? "#ffffff" : "#4b5563"
                font.family: "Berkeley Mono"
                font.pixelSize: 16
                font.weight: Font.Normal

                Behavior on color {
                    ColorAnimation { duration: 150; easing.type: Easing.OutQuint }
                }

                MouseArea {
                    id: dismissMouse
                    anchors.fill: parent
                    anchors.margins: -4
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                        root.notification.dismiss()
                        root.dismissed()
                    }
                }
            }
        }

        Text {
            text: root.notification.body
            color: "#9ca3af"
            font.family: "Berkeley Mono"
            font.pixelSize: 12
            font.weight: Font.Normal
            wrapMode: Text.WordWrap
            lineHeight: 1.4
            Layout.fillWidth: true
            visible: text.length > 0
            maximumLineCount: 3
            elide: Text.ElideRight
        }

        Text {
            text: root.notification.appName
            color: "#4b5563"
            font.family: "Berkeley Mono"
            font.pixelSize: 11
            font.weight: Font.Normal
            elide: Text.ElideRight
            Layout.fillWidth: true
            visible: text.length > 0
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

                    implicitWidth: actionText.implicitWidth + 12
                    implicitHeight: actionText.implicitHeight + 6
                    color: actionMouse.containsMouse ? "#1f2937" : "transparent"
                    border.width: 1
                    border.color: actionMouse.containsMouse ? "#374151" : "#1f2937"
                    radius: 4

                    Behavior on color {
                        ColorAnimation { duration: 150; easing.type: Easing.OutQuint }
                    }

                    Behavior on border.color {
                        ColorAnimation { duration: 150; easing.type: Easing.OutQuint }
                    }

                    Text {
                        id: actionText
                        anchors.centerIn: parent
                        text: modelData.text
                        color: "#9ca3af"
                        font.family: "Berkeley Mono"
                        font.pixelSize: 11
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
        interval: root.notification.expireTimeout > 0 ? root.notification.expireTimeout : 5000
        running: true
        onTriggered: {
            root.notification.expire()
            root.expired()
        }
    }
}
