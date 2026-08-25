// OverlayHost.qml
// Per-screen overlay container for ephemeral UI like volume/brightness OSD.
// Why: OSDs need to appear above all content without taking exclusive zone.
//      The host stays fullscreen for easy positioning, but the mask restricts
//      the live layer region to the loaded OSD so it does not steal clicks.

import Quickshell
import Quickshell.Wayland
import QtQuick

import "../design" as Design

PanelWindow {
    id: root

    required property var screen

    // only materialize when an osd exists.
    // why: an always-visible fullscreen PanelWindow can intercept pointer input
    //      across the monitor even when transparent.
    visible: osdLoader.item !== null
    color: "transparent"

    // constrain the surface + input region to the active osd bounds.
    // why: the host stays fullscreen for easy positioning, but only the osd
    //      itself should exist as an interactive layer-shell region.
    mask: Region {
        item: osdLoader.item ? osdLoader.item : emptyMask
    }

    Item {
        id: emptyMask
        width: 0
        height: 0
    }

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

    property var hideTimer: null

    Item {
        anchors.fill: parent

        Loader {
            id: osdLoader
            anchors.top: parent.top
            anchors.right: parent.right
            anchors.topMargin: Design.Theme.t.space3
            anchors.rightMargin: Design.Theme.t.space3
            active: false
            sourceComponent: null
        }
    }

    // show(component, props, {timeoutMs})
    // why: components are loaded on demand and destroyed after hide to keep
    //      memory usage minimal. timeout ensures ephemeral ui doesn't linger.
    function show(component, props, options) {
        const timeoutMs = options?.timeoutMs ?? 2000

        if (hideTimer) {
            hideTimer.stop()
            hideTimer.destroy()
            hideTimer = null
        }

        const shouldReload = osdLoader.sourceComponent !== component || osdLoader.item === null

        if (shouldReload) {
            osdLoader.active = false
            osdLoader.sourceComponent = component
            osdLoader.active = true
        }

        if (osdLoader.item && props) {
            for (const key in props) {
                osdLoader.item[key] = props[key]
            }
        }

        const timer = Qt.createQmlObject(
            `import QtQuick; Timer { interval: ${timeoutMs}; running: true; onTriggered: { root.hide(); } }`,
            root
        )
        hideTimer = timer
    }

    function hide() {
        osdLoader.active = false
        osdLoader.sourceComponent = null

        if (hideTimer) {
            hideTimer.stop()
            hideTimer.destroy()
            hideTimer = null
        }
    }
}
