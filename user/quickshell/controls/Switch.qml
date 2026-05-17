// Switch.qml
// Fluid Functionalism switch port.
// why: binary system state should read as an on/off switch, not as a selected button.

import QtQuick
import QtQuick.Layouts
import "../design" as Design

Item {
    id: root

    property bool checked: false
    property bool disabled: false
    property string label: ""
    property bool hovered: false
    property bool pressed: false
    // Mirrors Fluid's Elevated primitive: read the current substrate level and
    // render interactive surfaces as `min(substrate + offset, cap)`.
    property int substrateLevel: 3
    property int checkedOffset: 3
    property int checkedHoverOffset: 4
    property int surfaceCap: 8
    property bool dragging: false
    property real dragX: checked ? checkedX : uncheckedX
    property real pressStartX: 0
    property real pressOriginX: 0

    readonly property int trackWidth: 34
    readonly property int trackHeight: 20
    readonly property int thumbSize: 16
    readonly property int thumbOffset: 2
    readonly property int thumbTravel: trackWidth - thumbSize - thumbOffset * 2
    readonly property int pillExtend: 2
    readonly property int pressExtend: 4
    readonly property int pressShrink: 4
    readonly property int dragDeadZone: 2
    readonly property real activeThumbWidth: pressed ? thumbSize + pressExtend : (hovered ? thumbSize + pillExtend : thumbSize)
    readonly property real activeThumbHeight: pressed ? thumbSize - pressShrink : thumbSize
    readonly property real uncheckedX: thumbOffset
    readonly property real checkedX: thumbOffset + thumbTravel - (activeThumbWidth - thumbSize)
    readonly property real thumbY: pressed ? thumbOffset + pressShrink / 2 : thumbOffset

    signal toggled(bool checked)

    implicitWidth: trackWidth + (label.length > 0 ? labelText.implicitWidth + 10 : 0)
    implicitHeight: 32
    opacity: disabled ? 0.5 : 1

    onCheckedChanged: {
        if (!dragging) {
            dragX = checked ? checkedX : uncheckedX
        }
    }

    RowLayout {
        anchors.centerIn: parent
        spacing: 10

        Rectangle {
            id: track
            Layout.preferredWidth: root.trackWidth
            Layout.preferredHeight: root.trackHeight
            radius: root.trackHeight / 2
            color: root.checked
                ? Design.Theme.t.elevatedSurface(root.substrateLevel, root.hovered ? root.checkedHoverOffset : root.checkedOffset, root.surfaceCap)
                : (root.hovered ? Design.Theme.t.overlayOn(Design.Theme.t.accent, 0.10) : Design.Theme.t.accent)
            border.width: root.checked ? 1 : 0
            border.color: Design.Theme.t.border

            Behavior on color {
                ColorAnimation { duration: Design.Theme.t.durationFast }
            }

            Rectangle {
                id: thumb
                x: root.dragging ? root.dragX : (root.checked ? root.checkedX : root.uncheckedX)
                y: root.thumbY
                width: root.activeThumbWidth
                height: root.activeThumbHeight
                radius: height / 2
                color: Design.Theme.t.foreground

                Behavior on x {
                    enabled: !root.dragging
                    NumberAnimation { duration: Design.Theme.t.durationMed; easing.type: Easing.OutCubic }
                }

                Behavior on width {
                    NumberAnimation { duration: Design.Theme.t.durationFast; easing.type: Easing.OutCubic }
                }

                Behavior on height {
                    NumberAnimation { duration: Design.Theme.t.durationFast; easing.type: Easing.OutCubic }
                }

                Behavior on y {
                    NumberAnimation { duration: Design.Theme.t.durationFast; easing.type: Easing.OutCubic }
                }
            }
        }

        Text {
            id: labelText
            text: root.label
            visible: root.label.length > 0
            color: root.checked ? Design.Theme.t.foreground : Design.Theme.t.mutedForeground
            font.family: "Berkeley Mono"
            font.pixelSize: 13
            Layout.alignment: Qt.AlignVCenter

            Behavior on color {
                ColorAnimation { duration: Design.Theme.t.durationFast }
            }
        }
    }

    MouseArea {
        anchors.fill: parent
        enabled: !root.disabled
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor

        onEntered: root.hovered = true
        onExited: {
            root.hovered = false
            root.pressed = false
            root.dragging = false
            root.dragX = root.checked ? root.checkedX : root.uncheckedX
        }
        onPressed: function(mouse) {
            root.pressed = true
            root.dragging = false
            root.pressStartX = mouse.x
            root.pressOriginX = root.checked ? root.checkedX : root.uncheckedX
            root.dragX = root.pressOriginX
        }
        onPositionChanged: function(mouse) {
            if (!root.pressed) return

            const delta = mouse.x - root.pressStartX
            if (!root.dragging && Math.abs(delta) < root.dragDeadZone) return

            root.dragging = true
            const dragMax = root.trackWidth - root.thumbOffset - (root.thumbSize + root.pressExtend)
            root.dragX = Math.max(root.uncheckedX, Math.min(dragMax, root.pressOriginX + delta))
        }
        onReleased: {
            const wasDragging = root.dragging
            root.pressed = false
            root.dragging = false

            if (wasDragging) {
                const dragMax = root.trackWidth - root.thumbOffset - (root.thumbSize + root.pressExtend)
                const shouldBeOn = root.dragX > (root.uncheckedX + dragMax) / 2
                root.dragX = root.checked ? root.checkedX : root.uncheckedX
                if (shouldBeOn !== root.checked) root.toggled(shouldBeOn)
                return
            }

            root.toggled(!root.checked)
        }
        onCanceled: {
            root.pressed = false
            root.dragging = false
            root.dragX = root.checked ? root.checkedX : root.uncheckedX
        }
    }
}
