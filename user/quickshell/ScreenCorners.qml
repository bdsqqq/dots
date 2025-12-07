import Quickshell
import Quickshell.Wayland
import QtQuick

PanelWindow {
    id: corners

    property int cornerRadius: 8
    property int barHeight: 30
    property color cornerColor: "#000000"

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

    Canvas {
        id: topLeftCorner
        x: 0
        y: barHeight
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

    Canvas {
        id: topRightCorner
        x: parent.width - cornerRadius
        y: barHeight
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
