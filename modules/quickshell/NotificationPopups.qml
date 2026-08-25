import QtQuick
import QtQuick.Shapes
import Quickshell
import Quickshell.Wayland
import Quickshell.Services.Notifications

PanelWindow {
    id: popup

    required property var screen
    property int barHeight: 30
    property int popupWidth: 320
    property int cornerRadius: 8
    property int wmGap: 8

    property int enterDuration: 200
    property int exitDuration: 150

    property int maxHeight: screen.height - barHeight - wmGap - cornerRadius 

    property list<QtObject> notifications: []
    readonly property int notificationCount: notifications.length
    readonly property bool hasNotifications: notificationCount > 0

    anchors {
        top: true
        right: true
    }

    implicitWidth: hasNotifications ? popupWidth + cornerRadius : 1
    implicitHeight: hasNotifications ? Math.min(contentContainer.height + cornerRadius, maxHeight) : 1

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
        property bool removing: false

        function remove(): void {
            if (removing) return
            removing = true
            popup.notifications = popup.notifications.filter(n => n !== this)
        }

        function dismiss(): void {
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

    Item {
        id: contentContainer
        visible: popup.hasNotifications
        anchors.top: parent.top
        anchors.right: parent.right
        width: popupWidth + cornerRadius
        height: surface.height + cornerRadius

        // Top-left corner: concave rounded ┐
        Shape {
            id: topLeftCorner
            x: 0
            y: 0
            width: cornerRadius
            height: cornerRadius

            ShapePath {
                strokeWidth: -1
                fillColor: "#000000"

                startX: cornerRadius
                startY: 0

                PathLine { relativeX: 0; relativeY: cornerRadius }

                PathArc {
                    relativeX: -cornerRadius
                    relativeY: -cornerRadius
                    radiusX: cornerRadius
                    radiusY: cornerRadius
                    direction: PathArc.Counterclockwise
                }
            }
        }
        // bottom-right corner: concave rounded ┐
        Shape {
            id: bottomRightCorner
            x: 0
            y: 0
            width: cornerRadius
            height: cornerRadius

            ShapePath {
                strokeWidth: -1
                fillColor: "#000000"

                startX: popupWidth + cornerRadius - 1
                startY: surface.height

                PathLine { relativeX: 0; relativeY: cornerRadius }

                PathArc {
                    relativeX: -cornerRadius
                    relativeY: -cornerRadius
                    radiusX: cornerRadius
                    radiusY: cornerRadius
                    direction: PathArc.Counterclockwise
                }
            }
        }

        // Main notification surface
        Rectangle {
            id: surface
            x: cornerRadius
            y: 0
            width: popupWidth
            height: notificationList.contentHeight > 0 ? Math.min(notificationList.contentHeight - popup.cornerRadius, popup.maxHeight - popup.cornerRadius) : 0
            color: "#000000"
            clip: true
            bottomLeftRadius: cornerRadius

            Behavior on height {
                NumberAnimation {
                    duration: popup.exitDuration
                    easing.type: Easing.OutQuint
                }
            }

            ListView {
                id: notificationList
                anchors.fill: parent
                model: popup.notifications
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
                        ScriptAction {
                            script: delegateWrapper.modelData.dismiss()
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

                        onDismissed: delegateWrapper.modelData.remove()
                        onExpired: delegateWrapper.modelData.remove()
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
    }
}
