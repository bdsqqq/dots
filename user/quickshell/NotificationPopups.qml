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
    property int cornerRadius: 8
    property int wmGap: 8

    property int enterDuration: 200
    property int exitDuration: 150

    property int maxHeight: screen.height - barHeight - (wmGap * 2)

    anchors {
        top: true
        right: true
    }

    implicitWidth: popupWidth + cornerRadius
    implicitHeight: Math.min(surfaceColumn.implicitHeight + cornerRadius, maxHeight)

    color: "transparent"

    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.namespace: "quickshell-notifications"

    margins.top: barHeight

    exclusiveZone: 0

    mask: Region {
        item: Item {}
    }

    visible: notifServer.trackedNotifications.count > 0

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
        id: surfaceColumn
        anchors.top: connectorShape.bottom
        anchors.right: parent.right
        width: popupWidth + cornerRadius

        Rectangle {
            id: surface
            width: parent.width
            height: Math.min(notificationColumn.implicitHeight, popup.maxHeight - popup.cornerRadius * 2)
            color: "#000000"

            Behavior on height {
                NumberAnimation {
                    duration: popup.exitDuration
                    easing.type: Easing.OutQuint
                }
            }

            Column {
                id: notificationColumn
                anchors.top: parent.top
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.rightMargin: popup.cornerRadius
                clip: true

                Repeater {
                    model: notifServer.trackedNotifications

                    NotificationItem {
                        required property int index
                        required property Notification modelData
                        notification: modelData
                        width: notificationColumn.width
                        isLast: index === notifServer.trackedNotifications.count - 1

                        opacity: 1
                        transform: Translate { id: itemTranslate; y: 0 }

                        Behavior on opacity {
                            NumberAnimation {
                                duration: popup.exitDuration
                                easing.type: Easing.OutQuint
                            }
                        }
                    }
                }

                add: Transition {
                    NumberAnimation {
                        property: "opacity"
                        from: 0
                        to: 1
                        duration: popup.enterDuration
                        easing.type: Easing.OutQuint
                    }
                }

                move: Transition {
                    NumberAnimation {
                        properties: "y"
                        duration: popup.exitDuration
                        easing.type: Easing.OutQuint
                    }
                }
            }
        }

        Canvas {
            id: bottomLeftCorner
            width: cornerRadius
            height: cornerRadius

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
}
