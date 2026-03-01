// Slider.qml
// Slider control with normalized value API.
// why: sliders appear in multiple modules (brightness, volume). centralizing the
//      interaction logic and theming prevents duplication and inconsistency.
//
// @prop value - external source of truth, 0..1 normalized
// @signal changeEnd(value) - emitted when interaction completes
// @prop enabled - whether interaction is allowed
//
// sync model (why): external state (pipewire/brightnessctl) can lag user intent.
// showing `value` immediately after release causes a brief rollback flash.
// we keep rendering `dragValue` while pressed + during a short post-release
// window (`pendingExternalSync`), then hand back to `value` after convergence
// or timeout. this keeps UI intent stable without permanently diverging state.

import QtQuick
import "../design" as Design

Rectangle {
    id: root

    property real value: 0.5
    property bool enabled: true

    signal changeEnd(real value)
    property real dragValue: value
    property bool pendingExternalSync: false

    readonly property bool showingDragValue: mouse.pressed || pendingExternalSync
    readonly property real visualValue: showingDragValue ? dragValue : value

    implicitHeight: Design.Theme.t.space4 + Design.Theme.t.space2

    onValueChanged: {
        if (mouse.pressed) {
            return;
        }

        if (pendingExternalSync) {
            if (Math.abs(value - dragValue) <= 0.02) {
                pendingExternalSync = false;
                syncTimeout.stop();
            } else {
                return;
            }
        }

        dragValue = value;
    }

    // track styling
    color: Design.Theme.t.inactive
    radius: height / 2

    // fill indicator showing current value
    Rectangle {
        id: fill
        width: parent.width * root.visualValue
        height: parent.height
        color: enabled ? Design.Theme.t.active : Design.Theme.t.muted
        radius: root.radius

        Behavior on width {
            NumberAnimation {
                duration: Design.Theme.t.durationFast
                easing.type: Easing.OutQuint
            }
        }
    }

    Timer {
        id: syncTimeout
        interval: 350
        repeat: false
        onTriggered: {
            root.pendingExternalSync = false;
            root.dragValue = root.value;
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

        onPressed: function (mouse) {
            root.pendingExternalSync = false;
            syncTimeout.stop();
            updateValue(mouse.x);
        }

        onPositionChanged: function (mouse) {
            if (pressed) {
                updateValue(mouse.x);
            }
        }

        onReleased: {
            root.pendingExternalSync = true;
            syncTimeout.restart();
            root.changeEnd(root.dragValue);
        }
    }
}
