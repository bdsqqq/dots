pragma Singleton

/**
 * keeps persistence stupid-simple: one json file owned by the greeter runtime.
 *
 * why not read a user's home directly: a greeter runs before trust is
 * established, so depending on per-user paths turns permissions into hidden ui
 * bugs. the wrapper can mirror whatever it wants into this cache dir.
 */
import QtQuick
import Quickshell.Io
import "." as GreetCore

Item {
    id: root

    visible: false
    width: 0
    height: 0

    readonly property string memoryPath: GreetCore.GreetdSettings.configDir + "/memory.json"

    property string lastSessionId: ""
    property string lastSuccessfulUser: ""
    property bool memoryReady: false

    function parseMemory(content) {
        try {
            if (!content || !content.trim()) {
                root.normalizeMemory()
                return
            }

            const memory = JSON.parse(content)
            root.lastSessionId = GreetCore.GreetdSettings.rememberLastSession ? (memory.lastSessionId || "") : ""
            root.lastSuccessfulUser = GreetCore.GreetdSettings.rememberLastUser ? (memory.lastSuccessfulUser || "") : ""
            root.normalizeMemory()
        } catch (error) {
            console.warn("failed to parse greetd memory:", error)
            root.normalizeMemory()
        }
    }

    function normalizeMemory() {
        if (!GreetCore.GreetdSettings.rememberLastSession) {
            root.lastSessionId = ""
        }

        if (!GreetCore.GreetdSettings.rememberLastUser) {
            root.lastSuccessfulUser = ""
        }
    }

    function saveMemory() {
        root.normalizeMemory()

        const memory = {}
        if (GreetCore.GreetdSettings.rememberLastSession && root.lastSessionId) {
            memory.lastSessionId = root.lastSessionId
        }

        if (GreetCore.GreetdSettings.rememberLastUser && root.lastSuccessfulUser) {
            memory.lastSuccessfulUser = root.lastSuccessfulUser
        }

        memoryFile.setText(JSON.stringify(memory, null, 2))
    }

    function setLastSessionId(sessionId) {
        root.lastSessionId = sessionId || ""
        root.saveMemory()
    }

    function setLastSuccessfulUser(username) {
        root.lastSuccessfulUser = username || ""
        root.saveMemory()
    }

    FileView {
        id: memoryFile
        path: root.memoryPath
        blockLoading: false
        blockWrites: false
        atomicWrites: true
        watchChanges: false
        printErrors: false
    }

    Connections {
        target: memoryFile

        function onLoaded() {
            root.parseMemory(memoryFile.text())
            root.memoryReady = true
        }

        function onLoadFailed() {
            root.normalizeMemory()
            root.memoryReady = true
        }
    }

    Connections {
        target: GreetCore.GreetdSettings

        function onRememberLastSessionChanged() {
            root.saveMemory()
        }

        function onRememberLastUserChanged() {
            root.saveMemory()
        }
    }
}
