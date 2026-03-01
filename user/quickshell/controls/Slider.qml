// Slider.qml
// Slider control with normalized value API.
// why: sliders appear in multiple modules (brightness, volume). centralizing the
//      interaction logic and theming prevents duplication and inconsistency.
//
// @prop value - current position, 0..1 normalized
// @prop onChangeEnd - callback(value) invoked when interaction completes
// @prop enabled - whether interaction is allowed

import QtQuick
import "../design/Theme.qml" as Theme

Rectangle {
    id: root

    property real value: 0.5
    property var onChangeEnd: function(val) {}
    property bool enabled: true

    implicitHeight: 24

    // track styling
    color: Theme.t.c.inactive
    radius: Theme.t.radius.sm

    // fill indicator showing current value
    Rectangle {
        id: fill
        width: parent.width * root.value
        height: parent.height
        color: enabled ? Theme.t.c.active : Theme.t.c.muted
        radius: parent.radius

        Behavior on width {
            NumberAnimation { duration: Theme.t.durationFast; easing.type: Easing.OutQuint }
        }
    }

    // interaction area
    MouseArea {
        id: mouse
        anchors.fill: parent
        enabled: root.enabled
        hoverEnabled: true

        function updateValue(mouseX) {
            let newValue = Math.max(0, Math.min(1, mouseX / width))
            root.value = newValue
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
            root.onChangeEnd(root.value)
        }
    }
}
