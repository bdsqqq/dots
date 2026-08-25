import QtQuick
import QtQuick.Shapes

Item {
    id: root

    property var screen: null
    property color fillColor: "#000000"
    property real radius: 8
    property real revealProgress: 1
    property string edge: "auto" // auto | none | top | right | bottom | left | top-right | top-left | bottom-right | bottom-left
    property real gap: 0
    property real edgeThreshold: 2
    property bool alignMask: false

    readonly property real effectiveRadius: Math.max(0, Math.min(radius, width / 2, height / 2))
    readonly property real p: Math.max(0, Math.min(1, revealProgress))
    readonly property point absolutePos: mapToItem(null, 0, 0)
    readonly property real screenWidth: screen ? Number(screen.width ?? 0) : 0
    readonly property real screenHeight: screen ? Number(screen.height ?? 0) : 0

    readonly property bool touchingTop: Math.abs(absolutePos.y - gap) <= edgeThreshold
    readonly property bool touchingLeft: Math.abs(absolutePos.x - gap) <= edgeThreshold
    readonly property bool touchingRight: screenWidth > 0 ? Math.abs((absolutePos.x + width) - (screenWidth - gap)) <= edgeThreshold : false
    readonly property bool touchingBottom: screenHeight > 0 ? Math.abs((absolutePos.y + height) - (screenHeight - gap)) <= edgeThreshold : false

    readonly property string resolvedEdge: edge === "auto" ? detectEdge() : edge

    // state 0 normal, 1 horizontal inversion, 2 vertical inversion
    readonly property int topLeftState: cornerState("top-left")
    readonly property int topRightState: cornerState("top-right")
    readonly property int bottomLeftState: cornerState("bottom-left")
    readonly property int bottomRightState: cornerState("bottom-right")

    readonly property Item maskItem: maskAnchor
    default property alias contentData: contentItem.data

    function detectEdge(): string {
        if (touchingTop && touchingRight) return "top-right"
        if (touchingTop && touchingLeft) return "top-left"
        if (touchingBottom && touchingRight) return "bottom-right"
        if (touchingBottom && touchingLeft) return "bottom-left"
        if (touchingTop) return "top"
        if (touchingRight) return "right"
        if (touchingBottom) return "bottom"
        if (touchingLeft) return "left"
        return "none"
    }

    function edgeHas(token: string): bool {
        if (resolvedEdge === token) return true
        return resolvedEdge.indexOf(token) !== -1
    }

    function cornerState(corner: string): int {
        const onTop = corner.indexOf("top") !== -1
        const onBottom = corner.indexOf("bottom") !== -1
        const onLeft = corner.indexOf("left") !== -1
        const onRight = corner.indexOf("right") !== -1

        const touchTop = edgeHas("top")
        const touchBottom = edgeHas("bottom")
        const touchLeft = edgeHas("left")
        const touchRight = edgeHas("right")

        const touchesHorizontalEdge = (onLeft && touchLeft) || (onRight && touchRight)
        const touchesVerticalEdge = (onTop && touchTop) || (onBottom && touchBottom)

        if (touchesHorizontalEdge && touchesVerticalEdge) return 0
        if (touchesHorizontalEdge) return 2
        if (touchesVerticalEdge) return 1
        return 0
    }

    function targetMultX(state: int): real {
        return state === 1 ? -1 : 1
    }

    function targetMultY(state: int): real {
        return state === 2 ? -1 : 1
    }

    function lerpMult(start: real, target: real): real {
        return start + (target - start) * p
    }

    function arcDirection(multX: real, multY: real): int {
        return ((multX < 0) !== (multY < 0)) ? PathArc.Counterclockwise : PathArc.Clockwise
    }

    Shape {
        id: panelShape
        x: -root.effectiveRadius
        y: -root.effectiveRadius
        width: root.width + root.effectiveRadius * 2
        height: root.height + root.effectiveRadius * 2
        antialiasing: true

        readonly property real r: root.effectiveRadius
        readonly property real panelW: root.width
        readonly property real panelH: root.height

        readonly property real tlMultX: root.lerpMult(1, root.targetMultX(root.topLeftState))
        readonly property real tlMultY: root.lerpMult(1, root.targetMultY(root.topLeftState))
        readonly property real trMultX: root.lerpMult(1, root.targetMultX(root.topRightState))
        readonly property real trMultY: root.lerpMult(1, root.targetMultY(root.topRightState))
        readonly property real blMultX: root.lerpMult(1, root.targetMultX(root.bottomLeftState))
        readonly property real blMultY: root.lerpMult(1, root.targetMultY(root.bottomLeftState))
        readonly property real brMultX: root.lerpMult(1, root.targetMultX(root.bottomRightState))
        readonly property real brMultY: root.lerpMult(1, root.targetMultY(root.bottomRightState))

        ShapePath {
            strokeWidth: -1
            fillColor: root.fillColor

            startX: panelShape.r + panelShape.r * panelShape.tlMultX
            startY: panelShape.r

            PathLine {
                relativeX: panelShape.panelW - panelShape.r * panelShape.tlMultX - panelShape.r * panelShape.trMultX
                relativeY: 0
            }
            PathArc {
                relativeX: panelShape.r * panelShape.trMultX
                relativeY: panelShape.r * panelShape.trMultY
                radiusX: panelShape.r
                radiusY: panelShape.r
                direction: root.arcDirection(panelShape.trMultX, panelShape.trMultY)
            }

            PathLine {
                relativeX: 0
                relativeY: panelShape.panelH - panelShape.r * panelShape.trMultY - panelShape.r * panelShape.brMultY
            }
            PathArc {
                relativeX: -panelShape.r * panelShape.brMultX
                relativeY: panelShape.r * panelShape.brMultY
                radiusX: panelShape.r
                radiusY: panelShape.r
                direction: root.arcDirection(panelShape.brMultX, panelShape.brMultY)
            }

            PathLine {
                relativeX: -(panelShape.panelW - panelShape.r * panelShape.brMultX - panelShape.r * panelShape.blMultX)
                relativeY: 0
            }
            PathArc {
                relativeX: -panelShape.r * panelShape.blMultX
                relativeY: -panelShape.r * panelShape.blMultY
                radiusX: panelShape.r
                radiusY: panelShape.r
                direction: root.arcDirection(panelShape.blMultX, panelShape.blMultY)
            }

            PathLine {
                relativeX: 0
                relativeY: -(panelShape.panelH - panelShape.r * panelShape.blMultY - panelShape.r * panelShape.tlMultY)
            }
            PathArc {
                relativeX: panelShape.r * panelShape.tlMultX
                relativeY: -panelShape.r * panelShape.tlMultY
                radiusX: panelShape.r
                radiusY: panelShape.r
                direction: root.arcDirection(panelShape.tlMultX, panelShape.tlMultY)
            }
        }
    }

    Item {
        id: contentItem
        anchors.fill: parent
        clip: true
    }

    Item {
        id: maskAnchor
        visible: false
        x: root.alignMask ? root.x - root.effectiveRadius : -root.effectiveRadius
        y: root.alignMask ? root.y - root.effectiveRadius : -root.effectiveRadius
        width: root.width + root.effectiveRadius * 2
        height: root.height + root.effectiveRadius * 2
    }
}
