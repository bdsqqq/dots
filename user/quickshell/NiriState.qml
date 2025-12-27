pragma Singleton
import QtQuick
import Quickshell
import Quickshell.Io

QtObject {
    id: root

    property bool isFullscreen: false
    property int barHeight: 45
    
    property var _focusedWindowId: null
    property var _windows: ({})
    property var _screenSize: null

    property Socket _socket: Socket {
        id: niriSocket
        path: Quickshell.env("NIRI_SOCKET")
        connected: false

        onConnectedChanged: {
            if (connected) {
                write(JSON.stringify("EventStream") + "\n")
                flush()
            }
        }

        parser: SplitParser {
            onRead: data => {
                try {
                    const parsed = JSON.parse(data.trim())
                    root._handleEvent(parsed)
                } catch (e) {
                    console.error("NiriState: parse error", e)
                }
            }
        }
    }

    function _handleEvent(parsed) {
        if (parsed.Ok && parsed.Ok.Windows) {
            _handleWindowsChanged(parsed.Ok.Windows)
        } else if (parsed.WindowsChanged) {
            _handleWindowsChanged(parsed.WindowsChanged.windows)
        } else if (parsed.WindowOpenedOrChanged) {
            _handleWindowOpenedOrChanged(parsed.WindowOpenedOrChanged.window)
        } else if (parsed.WindowClosed) {
            delete _windows[parsed.WindowClosed.id]
            _updateFullscreen()
        } else if (parsed.WindowFocusChanged) {
            _focusedWindowId = parsed.WindowFocusChanged.id
            _updateFullscreen()
        } else if (parsed.WindowLayoutsChanged) {
            _handleLayoutsChanged(parsed.WindowLayoutsChanged.changes)
        }
    }

    function _handleWindowsChanged(windows) {
        _windows = {}
        for (const w of windows) {
            _windows[w.id] = w
            if (w.is_focused) _focusedWindowId = w.id
        }
        _updateFullscreen()
    }

    function _handleWindowOpenedOrChanged(window) {
        _windows[window.id] = window
        if (window.is_focused) _focusedWindowId = window.id
        _updateFullscreen()
    }

    function _handleLayoutsChanged(changes) {
        for (const [id, layout] of changes) {
            if (_windows[id]) {
                _windows[id].layout = layout
            }
        }
        _updateFullscreen()
    }

    function _updateFullscreen() {
        if (_focusedWindowId === null) {
            isFullscreen = false
            return
        }
        
        const focusedWindow = _windows[_focusedWindowId]
        if (!focusedWindow || !focusedWindow.layout) {
            isFullscreen = false
            return
        }

        const layout = focusedWindow.layout
        const tileSize = layout.tile_size
        
        if (!tileSize || !_screenSize) {
            isFullscreen = false
            return
        }

        // heuristic: if tile covers full screen dimensions, it's fullscreen
        // allow small tolerance for floating point/rounding
        const tolerance = 2
        const coversWidth = tileSize[0] >= (_screenSize.width - tolerance)
        const coversHeight = tileSize[1] >= (_screenSize.height - tolerance)
        
        isFullscreen = coversWidth && coversHeight
    }

    function setScreenSize(width, height) {
        _screenSize = { width: width, height: height }
        _updateFullscreen()
    }

    Component.onCompleted: {
        niriSocket.connected = true
    }
}
