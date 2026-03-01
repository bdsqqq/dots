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

    readonly property real screenWidth: screen ? Number(screen["width"] ?? 0) : 0
    readonly property real screenHeight: screen ? Number(screen["height"] ?? 0) : 0

    readonly property bool touchingTop: Math.abs(absolutePos.y - gap) <= edgeThreshold
    readonly property bool touchingLeft: Math.abs(absolutePos.x - gap) <= edgeThreshold
    readonly property bool touchingRight: screenWidth > 0 ? Math.abs((absolutePos.x + width) - (screenWidth - gap)) <= edgeThreshold : false
    readonly property bool touchingBottom: screenHeight > 0 ? Math.abs((absolutePos.y + height) - (screenHeight - gap)) <= edgeThreshold : false

    readonly property string resolvedEdge: edge === "auto" ? detectEdge() : edge

    // -1 flat, 0 convex, 1 concave-x, 2 concave-y
    readonly property int topLeftState: cornerState("top-left")
    readonly property int topRightState: cornerState("top-right")
    readonly property int bottomRightState: cornerState("bottom-right")
    readonly property int bottomLeftState: cornerState("bottom-left")

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

        if ((onTop && edgeHas("top")) || (onBottom && edgeHas("bottom")) || (onLeft && edgeHas("left")) || (onRight && edgeHas("right"))) {
            return (onTop || onBottom) ? 1 : 2
        }

        return 0
    }

    function isConcave(state: int): bool {
        return state === 1 || state === 2
    }

    Shape {
        anchors.fill: parent
        antialiasing: true

        ShapePath {
            id: panelPath

            strokeWidth: -1
            fillColor: root.fillColor

            readonly property real r: root.effectiveRadius

            readonly property bool tlConcave: root.isConcave(root.topLeftState)
            readonly property bool trConcave: root.isConcave(root.topRightState)
            readonly property bool brConcave: root.isConcave(root.bottomRightState)
            readonly property bool blConcave: root.isConcave(root.bottomLeftState)

            startX: tlConcave ? 0 : r
            startY: 0

            PathLine {
                x: panelPath.trConcave ? root.width : root.width - panelPath.r
                y: 0
            }
            PathArc {
                x: panelPath.trConcave ? root.width - panelPath.r * root.p : root.width
                y: panelPath.r
                radiusX: panelPath.r
                radiusY: panelPath.r
                direction: panelPath.trConcave ? PathArc.Counterclockwise : PathArc.Clockwise
            }

            PathLine {
                x: root.width
                y: panelPath.brConcave ? root.height : root.height - panelPath.r
            }
            PathArc {
                x: root.width - panelPath.r
                y: panelPath.brConcave ? root.height - panelPath.r * root.p : root.height
                radiusX: panelPath.r
                radiusY: panelPath.r
                direction: panelPath.brConcave ? PathArc.Counterclockwise : PathArc.Clockwise
            }

            PathLine {
                x: panelPath.blConcave ? 0 : panelPath.r
                y: root.height
            }
            PathArc {
                x: panelPath.blConcave ? panelPath.r * root.p : 0
                y: root.height - panelPath.r
                radiusX: panelPath.r
                radiusY: panelPath.r
                direction: panelPath.blConcave ? PathArc.Counterclockwise : PathArc.Clockwise
            }

            PathLine {
                x: 0
                y: panelPath.tlConcave ? 0 : panelPath.r
            }
            PathArc {
                x: panelPath.tlConcave ? panelPath.r * root.p : panelPath.r
                y: 0
                radiusX: panelPath.r
                radiusY: panelPath.r
                direction: panelPath.tlConcave ? PathArc.Counterclockwise : PathArc.Clockwise
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
        x: root.alignMask ? root.x : 0
        y: root.alignMask ? root.y : 0
        width: root.width
        height: root.height
    }
}
