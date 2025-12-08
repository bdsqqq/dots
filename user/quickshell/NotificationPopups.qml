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
    readonly property int notificationCount: notifications.filter(n => !n.closed).length
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
        property bool closed: false
        property var locks: ({})
        property int lockCount: 0

        function lock(item: Item): void {
            if (!locks[item]) {
                locks[item] = true
                lockCount++
            }
        }

        function unlock(item: Item): void {
            if (locks[item]) {
                delete locks[item]
                lockCount--
                if (closed && lockCount === 0) {
                    actuallyRemove()
                }
            }
        }

        function close(): void {
            closed = true
            if (lockCount === 0) {
                actuallyRemove()
            }
        }

        function actuallyRemove(): void {
            popup.notifications = popup.notifications.filter(n => n !== this)
            if (notification) {
                notification.dismiss()
            }
            destroy()
        }
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

            Item {
                width: cornerRadius
                height: cornerRadius

                Canvas {
                    anchors.fill: parent
                    onPaint: {
                        var ctx = getContext("2d")
                        ctx.clearRect(0, 0, width, height)
                        ctx.fillStyle = "#000000"
                        ctx.beginPath()
                        ctx.rect(0, 0, width, height)
                        ctx.moveTo(0, 0)
                        ctx.arc(0, 0, cornerRadius, 0, Math.PI / 2, false)
                        ctx.closePath()
                        ctx.fillRule = Qt.OddEvenFill
                        ctx.fill()
                    }
                    Component.onCompleted: requestPaint()
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
            height: notificationList.contentHeight > 0 ? Math.min(notificationList.contentHeight, popup.maxHeight - popup.cornerRadius * 2) : 0
            color: "#000000"
            clip: true

            Behavior on height {
                NumberAnimation {
                    duration: popup.exitDuration
                    easing.type: Easing.OutQuint
                }
            }

            ListView {
                id: notificationList
                anchors.fill: parent
                model: popup.notifications.filter(n => !n.closed)
                spacing: 0
                interactive: false

                delegate: Item {
                    id: delegateWrapper
                    required property QtObject modelData
                    required property int index

                    width: notificationList.width
                    height: notifItem.height
                    opacity: 1
                    x: 0

                    Component.onCompleted: {
                        modelData.lock(this)
                    }

                    Component.onDestruction: {
                        modelData.unlock(this)
                    }

                    ListView.onRemove: removeAnim.start()

                    SequentialAnimation {
                        id: removeAnim

                        PropertyAction {
                            target: delegateWrapper
                            property: "ListView.delayRemove"
                            value: true
                        }
                        ParallelAnimation {
                            NumberAnimation {
                                target: delegateWrapper
                                property: "opacity"
                                to: 0
                                duration: popup.exitDuration
                                easing.type: Easing.OutQuint
                            }
                            NumberAnimation {
                                target: delegateWrapper
                                property: "x"
                                to: popup.popupWidth
                                duration: popup.exitDuration
                                easing.type: Easing.OutQuint
                            }
                            NumberAnimation {
                                target: delegateWrapper
                                property: "height"
                                to: 0
                                duration: popup.exitDuration
                                easing.type: Easing.OutQuint
                            }
                        }
                        PropertyAction {
                            target: delegateWrapper
                            property: "ListView.delayRemove"
                            value: false
                        }
                    }

                    NotificationItem {
                        id: notifItem
                        notification: delegateWrapper.modelData.notification
                        width: parent.width
                        isLast: delegateWrapper.index === popup.notificationCount - 1

                        onDismissed: delegateWrapper.modelData.close()
                        onExpired: delegateWrapper.modelData.close()
                    }
                }

                add: Transition {
                    ParallelAnimation {
                        NumberAnimation {
                            property: "opacity"
                            from: 0
                            to: 1
                            duration: popup.enterDuration
                            easing.type: Easing.OutQuint
                        }
                        NumberAnimation {
                            property: "x"
                            from: popup.popupWidth
                            to: 0
                            duration: popup.enterDuration
                            easing.type: Easing.OutQuint
                        }
                    }
                }

                displaced: Transition {
                    NumberAnimation {
                        property: "y"
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

            Item {
                width: cornerRadius
                height: cornerRadius

                Canvas {
                    anchors.fill: parent
                    onPaint: {
                        var ctx = getContext("2d")
                        ctx.clearRect(0, 0, width, height)
                        ctx.fillStyle = "#000000"
                        ctx.beginPath()
                        ctx.moveTo(width, 0)
                        ctx.arc(width, 0, cornerRadius, Math.PI / 2, Math.PI, false)
                        ctx.closePath()
                        ctx.fill()
                    }
                    Component.onCompleted: requestPaint()
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
