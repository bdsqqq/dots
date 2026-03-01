import QtQuick
import QtQuick.Layouts
import Quickshell.Services.Notifications
import "design" as Design

Item {
    id: root

    required property Notification notification
    required property bool isLast

    property int padding: Design.Theme.t.space4
    readonly property string actionsKey: "actions"
    property var notificationActions: root.notification[root.actionsKey] || []

    signal dismissed()
    signal expired()

    implicitWidth: parent ? parent.width : contentLayout.implicitWidth + padding * 2
    implicitHeight: contentLayout.implicitHeight + padding * 2

    Rectangle {
        anchors.fill: parent
        color: "transparent"
        bottomLeftRadius: Design.Theme.t.radiusMd
        clip: true
    }

    ColumnLayout {
        id: contentLayout
        anchors.fill: parent
        anchors.margins: root.padding
        spacing: Design.Theme.t.space1

        RowLayout {
            Layout.fillWidth: true
            spacing: Design.Theme.t.space2

            Text {
                text: root.notification.summary || "notification"
                color: Design.Theme.t.fg
                font.family: "Berkeley Mono"
                font.pixelSize: Design.Theme.t.bodyMd
                font.weight: Font.Medium
                elide: Text.ElideRight
                Layout.fillWidth: true
            }

            Text {
                id: dismissButton
                text: "×"
                color: dismissMouse.containsMouse ? Design.Theme.t.fg : Design.Theme.t.border
                font.family: "Berkeley Mono"
                font.pixelSize: Design.Theme.t.textBase
                font.weight: Font.Normal

                Behavior on color {
                    ColorAnimation { duration: Design.Theme.t.durationSlow; easing.type: Easing.OutQuint }
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
            color: Design.Theme.t.muted
            font.family: "Berkeley Mono"
            font.pixelSize: Design.Theme.t.bodySm
            font.weight: Font.Normal
            wrapMode: Text.WordWrap
            lineHeight: 1.35
            Layout.fillWidth: true
            visible: text.length > 0
            maximumLineCount: 3
            elide: Text.ElideRight
        }

        Text {
            text: root.notification.appName
            color: Design.Theme.t.subtle
            font.family: "Berkeley Mono"
            font.pixelSize: Design.Theme.t.text2xs
            font.weight: Font.Normal
            elide: Text.ElideRight
            Layout.fillWidth: true
            visible: text.length > 0
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.topMargin: Design.Theme.t.space1
            spacing: Design.Theme.t.space2

            Repeater {
                model: root.notificationActions

                Rectangle {
                    id: actionChip
                    required property NotificationAction modelData

                    implicitWidth: actionText.implicitWidth + Design.Theme.t.space3
                    implicitHeight: actionText.implicitHeight + Design.Theme.t.space1 + 2
                    color: actionMouse.containsMouse ? Design.Theme.t.bgHover : "transparent"
                    border.width: 1
                    border.color: actionMouse.containsMouse ? Design.Theme.t.gray700 : Design.Theme.t.bg
                    radius: Design.Theme.t.radiusSm

                    Behavior on color {
                        ColorAnimation { duration: Design.Theme.t.durationSlow; easing.type: Easing.OutQuint }
                    }

                    Behavior on border.color {
                        ColorAnimation { duration: Design.Theme.t.durationSlow; easing.type: Easing.OutQuint }
                    }

                    Text {
                        id: actionText
                        anchors.centerIn: parent
                        text: actionChip.modelData.text
                        color: Design.Theme.t.muted
                        font.family: "Berkeley Mono"
                        font.pixelSize: Design.Theme.t.text2xs
                    }

                    MouseArea {
                        id: actionMouse
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: actionChip.modelData.invoke()
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
