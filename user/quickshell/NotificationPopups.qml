import QtQuick
import QtQuick.Shapes
import Quickshell
import Quickshell.Wayland
import Quickshell.Services.Notifications

PanelWindow {
    id: popup

    required property var screen
    property int barHeight: 45
    property int popupWidth: 320
    property int popupPadding: 8
    property int cornerRadius: 8
    property int maxPopups: 5

    anchors {
        top: true
        right: true
    }

    implicitWidth: popupWidth + popupPadding * 2 + cornerRadius
    implicitHeight: Math.min(notificationColumn.implicitHeight + popupPadding + cornerRadius, screen.height - barHeight)

    color: "transparent"

    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.namespace: "quickshell-notifications"

    margins.top: barHeight

    exclusiveZone: 0

    mask: Region {
        item: Item {}
    }

    NotificationServer {
        id: notifServer
        bodySupported: true
        actionsSupported: true
        imageSupported: true

        onNotification: notification => {
            notification.tracked = true
        }
    }

    Shape {
        id: connectorShape
        anchors.top: parent.top
        anchors.right: parent.right
        width: cornerRadius
        height: cornerRadius
        visible: notifServer.trackedNotifications.count > 0

        ShapePath {
            fillColor: "#000000"
            strokeWidth: -1

            startX: connectorShape.width
            startY: 0

            PathLine { x: 0; y: 0 }
            PathArc {
                x: connectorShape.width
                y: connectorShape.height
                radiusX: popup.cornerRadius
                radiusY: popup.cornerRadius
                direction: PathArc.Counterclockwise
            }
            PathLine { x: connectorShape.width; y: 0 }
        }
    }

    Column {
        id: notificationColumn
        anchors.top: connectorShape.bottom
        anchors.right: parent.right
        anchors.rightMargin: popupPadding
        width: popupWidth
        spacing: 8

        Repeater {
            model: {
                const tracked = notifServer.trackedNotifications
                const count = Math.min(tracked.count, popup.maxPopups)
                const result = []
                for (let i = 0; i < count; i++) {
                    result.push(tracked.get(i))
                }
                return result
            }

            NotificationItem {
                required property Notification modelData
                notification: modelData
                width: popup.popupWidth

                opacity: 1

                Behavior on opacity {
                    NumberAnimation { duration: 150 }
                }
            }
        }

        add: Transition {
            NumberAnimation { property: "opacity"; from: 0; to: 1; duration: 150 }
            NumberAnimation { property: "y"; from: -20; duration: 150; easing.type: Easing.OutQuad }
        }

        move: Transition {
            NumberAnimation { properties: "y"; duration: 150; easing.type: Easing.OutQuad }
        }
    }

    Canvas {
        id: bottomLeftCorner
        anchors.top: notificationColumn.bottom
        anchors.right: notificationColumn.right
        anchors.rightMargin: -cornerRadius
        width: cornerRadius
        height: cornerRadius
        visible: notifServer.trackedNotifications.count > 0

        onPaint: {
            var ctx = getContext("2d")
            ctx.clearRect(0, 0, width, height)
            ctx.fillStyle = "#000000"
            ctx.beginPath()
            ctx.moveTo(0, 0)
            ctx.lineTo(0, height)
            ctx.arcTo(0, 0, width, 0, cornerRadius)
            ctx.lineTo(0, 0)
            ctx.fill()
        }

        Component.onCompleted: requestPaint()
    }
}
