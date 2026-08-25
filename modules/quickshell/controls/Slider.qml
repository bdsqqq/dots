// Slider.qml
// Fluid Functionalism compact slider port with normalized value API.
// why: upstream uses a 20px thumb hitbox, 16px visible thumb, 18px bordered
//      track, hover preview, and snapped movement so state changes are legible.
//
// @prop value - external source of truth, minimumValue..maximumValue
// @prop step - value increment for snapping
// @signal changeEnd(value) - emitted when interaction completes

import QtQuick
import "../design" as Design

Item {
    id: root

    property real value: 0.5
    property real minimumValue: 0
    property real maximumValue: 1
    property real step: 0.01
    property bool enabled: true
    property bool showTicks: true
    property var tickValues: [0.25, 0.5, 0.75]

    signal changeEnd(real value)

    property real dragValue: clamp(value)
    property bool pendingExternalSync: false
    property bool hovered: false
    property bool pressed: false
    property real hoverValue: dragValue

    readonly property int thumbSize: 20
    readonly property int thumbRestSize: 16
    readonly property int trackHeight: 18
    readonly property int trackInset: 1
    readonly property bool showingDragValue: pressed || pendingExternalSync
    readonly property real visualValue: showingDragValue ? dragValue : clamp(value)
    readonly property real visualPercent: percentForValue(visualValue)
    readonly property real hoverPercent: percentForValue(hoverValue)
    readonly property real usableWidth: Math.max(0, width - thumbSize)
    readonly property real thumbX: visualPercent * usableWidth
    readonly property real thumbCenterX: thumbX + thumbSize / 2
    readonly property real hoverCenterX: hoverPercent * usableWidth + thumbSize / 2

    implicitHeight: thumbSize + 16
    opacity: enabled ? 1 : 0.5

    function clamp(v) {
        return Math.max(minimumValue, Math.min(maximumValue, v))
    }

    function snap(v) {
        if (step <= 0) return clamp(v)
        return clamp(Math.round((v - minimumValue) / step) * step + minimumValue)
    }

    function percentForValue(v) {
        if (maximumValue === minimumValue) return 0
        return Math.max(0, Math.min(1, (v - minimumValue) / (maximumValue - minimumValue)))
    }

    function valueForX(localX) {
        const usable = Math.max(1, width - thumbSize)
        const thumbLeft = Math.max(0, Math.min(usable, localX - thumbSize / 2))
        return snap(minimumValue + (thumbLeft / usable) * (maximumValue - minimumValue))
    }

    onValueChanged: {
        if (pressed) return

        if (pendingExternalSync) {
            if (Math.abs(value - dragValue) <= Math.max(step * 2, 0.02)) {
                pendingExternalSync = false
                syncTimeout.stop()
            } else {
                return
            }
        }

        dragValue = clamp(value)
    }

    Rectangle {
        id: track
        x: root.trackInset
        y: Math.round((root.height - root.trackHeight) / 2)
        width: Math.max(0, root.width - root.trackInset * 2)
        height: root.trackHeight
        radius: height / 2
        color: "transparent"
        border.width: 1
        border.color: Design.Theme.t.border
        clip: true

        Rectangle {
            id: fill
            x: 0
            y: 0
            width: Math.max(0, Math.min(track.width, root.thumbCenterX - track.x))
            height: parent.height
            radius: parent.radius
            color: root.enabled ? Design.Theme.t.active : Design.Theme.t.muted

            Behavior on width {
                enabled: !root.pressed
                NumberAnimation { duration: 140; easing.type: Easing.OutCubic }
            }
        }

        Repeater {
            model: root.showTicks ? root.tickValues : []

            Rectangle {
                readonly property real tickValue: Number(modelData)
                width: 3
                height: 3
                radius: 1.5
                x: Math.max(0, Math.min(track.width - width, root.percentForValue(tickValue) * track.width - width / 2))
                y: Math.round((track.height - height) / 2)
                color: root.percentForValue(tickValue) <= root.visualPercent ? Design.Theme.t.bg : Design.Theme.t.border
                opacity: root.percentForValue(tickValue) <= root.visualPercent ? 0.9 : 1

                Behavior on color {
                    ColorAnimation { duration: Design.Theme.t.durationFast }
                }
            }
        }

        Rectangle {
            id: hoverPreview
            visible: root.hovered && !root.pressed && root.enabled
            x: Math.max(0, Math.min(root.thumbCenterX, root.hoverCenterX) - track.x)
            y: 0
            width: Math.abs(root.hoverCenterX - root.thumbCenterX)
            height: parent.height
            radius: parent.radius
            color: Design.Theme.t.overlayOn(Design.Theme.t.accent, 0.18)
            opacity: visible ? 1 : 0

            Behavior on opacity {
                NumberAnimation { duration: Design.Theme.t.durationMed; easing.type: Easing.OutQuad }
            }
        }
    }

    Item {
        id: thumbBox
        x: root.thumbX
        y: Math.round((root.height - root.thumbSize) / 2)
        width: root.thumbSize
        height: root.thumbSize

        Behavior on x {
            enabled: !root.pressed
            NumberAnimation { duration: 140; easing.type: Easing.OutCubic }
        }

        Rectangle {
            anchors.centerIn: parent
            width: root.thumbRestSize
            height: root.thumbRestSize
            radius: width / 2
            color: "white"
            border.width: Design.Theme.t.isLight ? 1 : 0
            border.color: Design.Theme.t.border

            Behavior on width { NumberAnimation { duration: Design.Theme.t.durationFast } }
            Behavior on height { NumberAnimation { duration: Design.Theme.t.durationFast } }
        }
    }

    Timer {
        id: syncTimeout
        interval: 350
        repeat: false
        onTriggered: {
            root.pendingExternalSync = false
            root.dragValue = root.clamp(root.value)
        }
    }

    MouseArea {
        id: mouse
        anchors.fill: parent
        enabled: root.enabled
        hoverEnabled: true
        cursorShape: Qt.SizeHorCursor

        onEntered: root.hovered = true
        onExited: {
            root.hovered = false
            root.pressed = false
        }
        onPositionChanged: function(mouse) {
            root.hoverValue = root.valueForX(mouse.x)
            if (pressed) root.dragValue = root.hoverValue
        }
        onPressed: function(mouse) {
            root.pendingExternalSync = false
            syncTimeout.stop()
            root.pressed = true
            root.hoverValue = root.valueForX(mouse.x)
            root.dragValue = root.hoverValue
        }
        onReleased: {
            root.pressed = false
            root.pendingExternalSync = true
            syncTimeout.restart()
            root.changeEnd(root.dragValue)
        }
        onCanceled: root.pressed = false
    }
}
