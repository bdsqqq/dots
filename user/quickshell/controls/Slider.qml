// Slider.qml
// Slider control with normalized value API.
// why: sliders appear in multiple modules (brightness, volume). centralizing the
//      interaction logic and theming prevents duplication and inconsistency.
//
// @prop value - current position, 0..1 normalized
// @signal changeEnd(value) - emitted when interaction completes
// @prop enabled - whether interaction is allowed

import QtQuick
import "../design" as Design

Rectangle {
    id: root

    property real value: 0.5
    property bool enabled: true

    signal changeEnd(real value)
    property real dragValue: value

    readonly property real visualValue: mouse.pressed ? dragValue : value

    implicitHeight: 24

    onValueChanged: {
        if (!mouse.pressed) {
            dragValue = value;
        }
    }

    // track styling
    color: Design.Theme.t.inactive
    radius: Design.Theme.t.radiusSm

    // fill indicator showing current value
    Rectangle {
        id: fill
        width: parent.width * root.visualValue
        height: parent.height
        color: enabled ? Design.Theme.t.active : Design.Theme.t.muted
        radius: root.radius

        Behavior on width {
            NumberAnimation { duration: Design.Theme.t.durationFast; easing.type: Easing.OutQuint }
        }
    }

    // interaction area
    MouseArea {
        id: mouse
        anchors.fill: parent
        enabled: root.enabled
        hoverEnabled: true

        function updateValue(mouseX: real): void {
            root.dragValue = Math.max(0, Math.min(1, mouseX / width));
        }

        onPressed: function(mouse) {
            updateValue(mouse.x)
        }

        onPositionChanged: function(mouse) {
            if (pressed) {
                updateValue(mouse.x)
            }
        }

        onReleased: {
            root.changeEnd(root.dragValue)
        }
    }
}
