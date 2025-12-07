import QtQuick
import Quickshell
import Quickshell.Io

Item {
    id: root
    
    width: workspacesRow.width
    height: workspacesRow.height

    property ListModel workspaces: ListModel {}

    Component.onCompleted: {
        niriSocket.connected = true
    }

    Socket {
        id: niriSocket
        path: Quickshell.env("NIRI_SOCKET")
        connected: false

        onConnectedChanged: {
            if (connected) {
                write(JSON.stringify("EventStream") + "\n")
                flush()
                write(JSON.stringify("Workspaces") + "\n")
                flush()
            }
        }

        parser: SplitParser {
            onRead: data => {
                try {
                    const parsed = JSON.parse(data.trim())
                    
                    if (parsed.Ok && parsed.Ok.Workspaces) {
                        recollectWorkspaces(parsed.Ok.Workspaces)
                    } else if (parsed.WorkspacesChanged) {
                        recollectWorkspaces(parsed.WorkspacesChanged.workspaces)
                    } else if (parsed.WorkspaceActivated) {
                        niriSocket.write(JSON.stringify("Workspaces") + "\n")
                        niriSocket.flush()
                    }
                } catch (e) {
                    console.error("NiriWorkspaces: parse error", e, data)
                }
            }
        }
    }

    function recollectWorkspaces(workspacesData) {
        const list = []
        for (const ws of workspacesData) {
            list.push({
                "id": ws.id,
                "idx": ws.idx,
                "name": ws.name || "",
                "output": ws.output || "",
                "isFocused": ws.is_focused === true,
                "isActive": ws.is_active === true
            })
        }
        list.sort((a, b) => {
            if (a.output !== b.output) return a.output.localeCompare(b.output)
            return a.idx - b.idx
        })
        
        workspaces.clear()
        for (var i = 0; i < list.length; i++) {
            workspaces.append(list[i])
        }
    }

    function focusWorkspace(idx) {
        Quickshell.execDetached(["niri", "msg", "action", "focus-workspace", idx.toString()])
    }

    Row {
        id: workspacesRow
        spacing: 0

        Repeater {
            model: workspaces

            Text {
                required property int index
                property var ws: workspaces.get(index)

                text: "[" + (ws ? ws.idx : "") + "]"
                color: ws && ws.isFocused ? "#d1d5db" : "#6b7280"
                font.family: "Berkeley Mono"
                font.pixelSize: 16
                font.bold: ws ? ws.isFocused : false

                MouseArea {
                    anchors.fill: parent
                    onClicked: {
                        if (ws) root.focusWorkspace(ws.idx)
                    }
                }
            }
        }
    }
}
