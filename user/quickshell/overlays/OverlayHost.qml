// OverlayHost.qml
// Per-screen overlay container for ephemeral UI like volume/brightness OSD.
// Why: OSDs need to appear above all content without taking exclusive zone.
//      Centralizing the show/hide logic and auto-timeout prevents duplication
//      across OSD types and ensures consistent behavior.

import Quickshell
import Quickshell.Wayland
import QtQuick

PanelWindow {
    id: root

    required property var screen

    // always visible but transparent when no content
    visible: true
    color: "transparent"

    // cover the whole screen for positioning flexibility
    anchors.top: true
    anchors.bottom: true
    anchors.left: true
    anchors.right: true
    screen: root.screen

    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.namespace: "quickshell-overlay-host"

    // non-exclusive: does not reserve space
    exclusiveZone: 0

    // currently displayed OSD component
    property var activeOsd: null
    property var hideTimer: null

    // show(component, props, {timeoutMs})
    // why: components are loaded on demand and destroyed after hide to keep
    //      memory usage minimal. timeout ensures ephemeral UI doesn't linger.
    function show(component, props, options) {
        const timeoutMs = options?.timeoutMs ?? 2000

        // clear existing
        if (hideTimer) {
            hideTimer.stop()
            hideTimer.destroy()
            hideTimer = null
        }
        if (activeOsd) {
            activeOsd.destroy()
            activeOsd = null
        }

        // create new instance
        const instance = component.createObject(root, props || {})
        if (!instance) {
            console.error("failed to create OSD instance")
            return
        }

        activeOsd = instance

        // center in screen
        instance.anchors.centerIn = root

        // auto-hide after timeout
        const timer = Qt.createQmlObject(
            `import QtQuick; Timer { interval: ${timeoutMs}; running: true; onTriggered: { root.hide(); } }`,
            root
        )
        hideTimer = timer
    }

    function hide() {
        if (activeOsd) {
            activeOsd.destroy()
            activeOsd = null
        }
        if (hideTimer) {
            hideTimer.stop()
            hideTimer.destroy()
            hideTimer = null
        }
    }
}
