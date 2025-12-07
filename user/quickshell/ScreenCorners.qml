import Quickshell
import Quickshell.Wayland
import QtQuick

Item {
    id: cornersRoot

    required property var screen

    property int cornerRadius: 8
    property color cornerColor: "#000000"

    PanelWindow {
        id: topLeft
        screen: cornersRoot.screen
        
        anchors.top: true
        anchors.left: true
        
        implicitWidth: cornerRadius
        implicitHeight: cornerRadius
        color: "transparent"
        
        WlrLayershell.layer: WlrLayer.Overlay
        WlrLayershell.namespace: "quickshell-corner-tl"
        exclusiveZone: 0

        Canvas {
            anchors.fill: parent
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
    }

    PanelWindow {
        id: topRight
        screen: cornersRoot.screen
        
        anchors.top: true
        anchors.right: true
        
        implicitWidth: cornerRadius
        implicitHeight: cornerRadius
        color: "transparent"
        
        WlrLayershell.layer: WlrLayer.Overlay
        WlrLayershell.namespace: "quickshell-corner-tr"
        exclusiveZone: 0

        Canvas {
            anchors.fill: parent
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
    }

    PanelWindow {
        id: bottomLeft
        screen: cornersRoot.screen
        
        anchors.bottom: true
        anchors.left: true
        
        implicitWidth: cornerRadius
        implicitHeight: cornerRadius
        color: "transparent"
        
        WlrLayershell.layer: WlrLayer.Overlay
        WlrLayershell.namespace: "quickshell-corner-bl"
        exclusiveZone: 0

        Canvas {
            anchors.fill: parent
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
    }

    PanelWindow {
        id: bottomRight
        screen: cornersRoot.screen
        
        anchors.bottom: true
        anchors.right: true
        
        implicitWidth: cornerRadius
        implicitHeight: cornerRadius
        color: "transparent"
        
        WlrLayershell.layer: WlrLayer.Overlay
        WlrLayershell.namespace: "quickshell-corner-br"
        exclusiveZone: 0

        Canvas {
            anchors.fill: parent
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
}
