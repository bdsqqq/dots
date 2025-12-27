import Quickshell
import Quickshell.Wayland
import QtQuick

PanelWindow {
    id: corners

    required property var screen
    required property var niriState

    property int cornerRadius: 8
    property color cornerColor: "#000000"
    property int barHeight: niriState ? niriState.barHeight : 45
    property int topOffset: (niriState && niriState.isFullscreen) ? 0 : barHeight

    anchors {
        top: true
        bottom: true
        left: true
        right: true
    }

    color: "transparent"

    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.namespace: "quickshell-corners"

    exclusiveZone: 0

    Component.onCompleted: {
        if (niriState) niriState.setScreenSize(screen.width, screen.height)
    }

    // Input mask: pass through everything except the 4 corner regions
    mask: Region {
        item: Item {}
        
        regions: [
            // Top-left corner (offset by bar when not fullscreen)
            Region { x: 0; y: topOffset; width: cornerRadius; height: cornerRadius },
            // Top-right corner  
            Region { x: corners.width - cornerRadius; y: topOffset; width: cornerRadius; height: cornerRadius },
            // Bottom-left corner
            Region { x: 0; y: corners.height - cornerRadius; width: cornerRadius; height: cornerRadius },
            // Bottom-right corner
            Region { x: corners.width - cornerRadius; y: corners.height - cornerRadius; width: cornerRadius; height: cornerRadius }
        ]
    }

    // Top-left corner
    Canvas {
        id: topLeftCorner
        x: 0
        y: topOffset
        width: cornerRadius
        height: cornerRadius

        onPaint: {
            var ctx = getContext("2d")
            ctx.clearRect(0, 0, width, height)
            ctx.fillStyle = cornerColor
            ctx.beginPath()
            ctx.moveTo(0, 0)
            ctx.lineTo(cornerRadius, 0)
            ctx.arcTo(0, 0, 0, cornerRadius, cornerRadius)
            ctx.lineTo(0, 0)
            ctx.fill()
        }

        Component.onCompleted: requestPaint()
    }

    // Top-right corner
    Canvas {
        id: topRightCorner
        x: parent.width - cornerRadius
        y: topOffset
        width: cornerRadius
        height: cornerRadius

        onPaint: {
            var ctx = getContext("2d")
            ctx.clearRect(0, 0, width, height)
            ctx.fillStyle = cornerColor
            ctx.beginPath()
            ctx.moveTo(cornerRadius, 0)
            ctx.lineTo(0, 0)
            ctx.arcTo(cornerRadius, 0, cornerRadius, cornerRadius, cornerRadius)
            ctx.lineTo(cornerRadius, 0)
            ctx.fill()
        }

        Component.onCompleted: requestPaint()
    }

    // Bottom-left corner
    Canvas {
        id: bottomLeftCorner
        x: 0
        y: parent.height - cornerRadius
        width: cornerRadius
        height: cornerRadius

        onPaint: {
            var ctx = getContext("2d")
            ctx.clearRect(0, 0, width, height)
            ctx.fillStyle = cornerColor
            ctx.beginPath()
            ctx.moveTo(0, cornerRadius)
            ctx.lineTo(0, 0)
            ctx.arcTo(0, cornerRadius, cornerRadius, cornerRadius, cornerRadius)
            ctx.lineTo(0, cornerRadius)
            ctx.fill()
        }

        Component.onCompleted: requestPaint()
    }

    // Bottom-right corner
    Canvas {
        id: bottomRightCorner
        x: parent.width - cornerRadius
        y: parent.height - cornerRadius
        width: cornerRadius
        height: cornerRadius

        onPaint: {
            var ctx = getContext("2d")
            ctx.clearRect(0, 0, width, height)
            ctx.fillStyle = cornerColor
            ctx.beginPath()
            ctx.moveTo(cornerRadius, cornerRadius)
            ctx.lineTo(cornerRadius, 0)
            ctx.arcTo(cornerRadius, cornerRadius, 0, cornerRadius, cornerRadius)
            ctx.lineTo(cornerRadius, cornerRadius)
            ctx.fill()
        }

        Component.onCompleted: requestPaint()
    }
}
