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

    property list<QtObject> notifications: []
    readonly property list<QtObject> visibleNotifications: notifications.filter(n => !n.closing)
    readonly property int notificationCount: visibleNotifications.length
    readonly property bool hasNotifications: notificationCount > 0

    anchors {
        top: true
        right: true
    }

    implicitWidth: hasNotifications ? popupWidth + cornerRadius : 1
    implicitHeight: hasNotifications ? Math.min(contentColumn.implicitHeight, maxHeight) : 1

    color: "transparent"

    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.namespace: "quickshell-notifications"

    margins.top: 0

    exclusiveZone: 0

    mask: Region {
        item: hasNotifications ? contentMask : emptyMask
    }

    Item {
        id: emptyMask
        width: 0
        height: 0
    }

    Item {
        id: contentMask
        x: 0
        y: 0
        width: popup.implicitWidth
        height: popup.implicitHeight
    }

    visible: true

    component NotifWrapper: QtObject {
        required property Notification notification
        property bool closing: false
    }

    NotificationServer {
        id: notifServer
        bodySupported: true
        actionsSupported: true
        imageSupported: true

        onNotification: notification => {
            notification.tracked = true
            const wrapper = wrapperComponent.createObject(popup, { notification: notification })
            popup.notifications = [wrapper, ...popup.notifications]
        }
    }

    Component {
        id: wrapperComponent
        NotifWrapper {}
    }

    function removeNotification(wrapper: QtObject): void {
        wrapper.closing = true
        removeTimer.wrapper = wrapper
        removeTimer.start()
    }

    Timer {
        id: removeTimer
        property QtObject wrapper: null
        interval: popup.exitDuration
        onTriggered: {
            if (wrapper) {
                popup.notifications = popup.notifications.filter(n => n !== wrapper)
                wrapper.notification.dismiss()
                wrapper.destroy()
            }
        }
    }

    Column {
        id: contentColumn
        visible: popup.hasNotifications
        anchors.top: parent.top
        anchors.right: parent.right
        width: popupWidth + cornerRadius

        Row {
            id: topRow
            width: parent.width
            height: cornerRadius

            Shape {
                id: concaveTopLeft
                width: cornerRadius
                height: cornerRadius

                ShapePath {
                    strokeWidth: 0
                    fillColor: "#000000"
                    fillRule: ShapePath.OddEvenFill

                    startX: 0
                    startY: 0

                    PathLine { x: cornerRadius; y: 0 }
                    PathLine { x: cornerRadius; y: cornerRadius }
                    PathLine { x: 0; y: cornerRadius }
                    PathLine { x: 0; y: 0 }

                    PathMove { x: 0; y: 0 }
                    PathLine { x: cornerRadius; y: 0 }

                    PathArc {
                        x: 0
                        y: cornerRadius
                        radiusX: cornerRadius
                        radiusY: cornerRadius
                        direction: PathArc.Counterclockwise
                    }

                    PathLine { x: 0; y: 0 }
                }
            }

            Rectangle {
                width: parent.width - cornerRadius
                height: cornerRadius
                color: "#000000"
            }
        }

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
                clip: true

                Repeater {
                    model: popup.visibleNotifications

                    NotificationItem {
                        required property int index
                        required property QtObject modelData
                        notification: modelData.notification
                        width: notificationColumn.width
                        isLast: index === popup.notificationCount - 1

                        onDismissed: popup.removeNotification(modelData)
                        onExpired: popup.removeNotification(modelData)
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

        Row {
            id: bottomRow
            width: parent.width
            height: cornerRadius

            Shape {
                id: convexBottomLeft
                width: cornerRadius
                height: cornerRadius

                ShapePath {
                    strokeWidth: 0
                    fillColor: "#000000"

                    startX: 0
                    startY: cornerRadius

                    PathLine { x: 0; y: 0 }

                    PathArc {
                        x: cornerRadius
                        y: cornerRadius
                        radiusX: cornerRadius
                        radiusY: cornerRadius
                        direction: PathArc.Counterclockwise
                    }

                    PathLine { x: 0; y: cornerRadius }
                }
            }

            Rectangle {
                width: parent.width - cornerRadius
                height: cornerRadius
                color: "#000000"
            }
        }
    }
}
