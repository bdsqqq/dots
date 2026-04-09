import QtQuick
import Qt.labs.folderlistmodel
import Quickshell
import Quickshell.Io
import Quickshell.Services.Greetd
import "." as GreetCore
import "GreetdPam.js" as GreetdPam

/**
 * owns the greetd conversation so a frontend can stay declarative.
 *
 * why this exists: greetd auth is a small state machine with awkward edges
 * around pam prompts, external auth, and launch timing. burying that in button
 * handlers makes every redesign re-learn the same failure cases.
 *
 * contract for consumers:
 * - call the public methods here instead of `Quickshell.Services.Greetd`
 * - bind visual state to `GreetdState`, `authFeedback`, and capability flags
 * - treat this item as headless plumbing; layout and focus belong outside
 */
Item {
    id: root

    visible: false
    width: 0
    height: 0

    readonly property bool pamHasFingerprint: GreetdPam.stackHasModule(root.greetdPamText, root.includedPamStacks, "pam_fprintd")
        && (!root.fprintdProbeComplete || root.fprintdHasDevice)
    readonly property bool pamHasU2f: GreetdPam.stackHasModule(root.greetdPamText, root.includedPamStacks, "pam_u2f")
    readonly property bool supportsFingerprint: root.pamHasFingerprint && GreetCore.GreetdSettings.enableFingerprint
    readonly property bool supportsU2f: root.pamHasU2f && GreetCore.GreetdSettings.enableU2f
    readonly property bool supportsExternalAuth: root.supportsFingerprint || root.supportsU2f
    readonly property bool busy: GreetCore.GreetdState.unlocking || Greetd.state !== GreetdState.Inactive || root.awaitingExternalAuth || root.pendingPasswordResponse
    readonly property string authFeedback: root.authFeedbackMessage
    readonly property string authState: root.authPhase
    readonly property int passwordAttemptLimitHint: root.inferredPasswordAttemptLimit
    readonly property string currentSessionName: GreetCore.GreetdState.sessionList[GreetCore.GreetdState.currentSessionIndex] || ""

    readonly property var includedPamStacks: [
        ["system-auth", root.systemAuthPamText],
        ["common-auth", root.commonAuthPamText],
        ["password-auth", root.passwordAuthPamText],
        ["system-login", root.systemLoginPamText],
        ["system-local-login", root.systemLocalLoginPamText],
        ["common-auth-pc", root.commonAuthPcPamText],
        ["login", root.loginPamText],
    ]

    readonly property var pamSources: [
        root.greetdPamText,
        root.systemAuthPamText,
        root.commonAuthPamText,
        root.passwordAuthPamText,
        root.systemLoginPamText,
        root.systemLocalLoginPamText,
        root.commonAuthPcPamText,
        root.loginPamText,
    ]

    readonly property string xdgDataDirs: Quickshell.env("XDG_DATA_DIRS")
    readonly property var sessionDirs: {
        const homeDir = Quickshell.env("HOME") || ""
        const dirs = [
            "/usr/share/wayland-sessions",
            "/usr/share/xsessions",
            "/usr/local/share/wayland-sessions",
            "/usr/local/share/xsessions",
        ]

        if (homeDir) {
            dirs.push(homeDir + "/.local/share/wayland-sessions")
            dirs.push(homeDir + "/.local/share/xsessions")
        }

        if (root.xdgDataDirs) {
            root.xdgDataDirs.split(":").forEach(dir => {
                if (!dir) {
                    return
                }

                dirs.push(dir + "/wayland-sessions")
                dirs.push(dir + "/xsessions")
            })
        }

        return dirs
    }

    property bool awaitingExternalAuth: false
    property bool pendingPasswordResponse: false
    property bool passwordSubmitRequested: false
    property bool cancelingExternalAuthForPassword: false
    property bool fprintdProbeComplete: false
    property bool fprintdHasDevice: false

    property int defaultAuthTimeoutMs: 10000
    property int externalAuthTimeoutMs: 30000
    property int memoryFlushDelayMs: 120
    property int maxPasswordSessionTransitionRetries: 2
    property int passwordSessionTransitionRetryCount: 0
    property int passwordFailureCount: 0
    property int inferredPasswordAttemptLimit: 0
    property int pendingSessionCount: 0

    property string authPhase: ""
    property string authFeedbackMessage: ""
    property string pendingLaunchCommand: ""
    property string externalAuthAutoStartedForUser: ""
    property string greetdPamText: ""
    property string systemAuthPamText: ""
    property string commonAuthPamText: ""
    property string passwordAuthPamText: ""
    property string systemLoginPamText: ""
    property string systemLocalLoginPamText: ""
    property string commonAuthPcPamText: ""
    property string loginPamText: ""
    property string faillockConfigText: ""

    property var pendingLaunchEnv: []
    property var pendingSessionFiles: ({})

    function encodeFileUrl(path) {
        if (!path) {
            return ""
        }

        return "file://" + path.split("/").map(segment => encodeURIComponent(segment)).join("/")
    }

    function currentAuthMessage() {
        if (root.authPhase === "error") {
            return "authentication error - try again"
        }

        if (root.authPhase === "max") {
            return "too many failed attempts - account may be locked"
        }

        if (root.authPhase === "fail") {
            if (root.inferredPasswordAttemptLimit > 0) {
                const attempt = Math.max(1, Math.min(root.passwordFailureCount, root.inferredPasswordAttemptLimit))
                const remaining = Math.max(root.inferredPasswordAttemptLimit - attempt, 0)
                if (remaining > 0) {
                    return "incorrect password - attempt " + attempt + " of " + root.inferredPasswordAttemptLimit + " (lockout may follow)"
                }

                return "incorrect password - next failures may trigger account lockout"
            }

            return "incorrect password"
        }

        return root.authFeedbackMessage
    }

    function clearAuthFeedback() {
        root.authPhase = ""
        root.authFeedbackMessage = ""
    }

    function resetPasswordSessionTransition(clearSubmitRequest) {
        root.cancelingExternalAuthForPassword = false
        root.passwordSessionTransitionRetryCount = 0
        if (clearSubmitRequest) {
            root.passwordSubmitRequested = false
        }
    }

    function refreshPasswordAttemptPolicyHint() {
        root.inferredPasswordAttemptLimit = GreetdPam.inferPasswordAttemptLimit(root.pamSources, root.faillockConfigText)
    }

    function applyRememberedUser() {
        if (!GreetCore.GreetdSettings.settingsLoaded || !GreetCore.GreetdMemory.memoryReady || !GreetCore.GreetdSettings.rememberLastUser) {
            return
        }

        const lastUser = GreetCore.GreetdMemory.lastSuccessfulUser
        if (lastUser && !GreetCore.GreetdState.username) {
            GreetCore.GreetdState.username = lastUser
            root.maybeAutoStartExternalAuth()
        }
    }

    function setUsername(rawValue) {
        const username = (rawValue || "").trim()
        if (!username) {
            return
        }

        if (GreetCore.GreetdState.username !== username) {
            root.passwordFailureCount = 0
            root.clearAuthFeedback()
            root.externalAuthAutoStartedForUser = ""
        }

        GreetCore.GreetdState.username = username
        GreetCore.GreetdState.clearPassword()
        root.pendingPasswordResponse = false
        root.resetPasswordSessionTransition(true)
        root.maybeAutoStartExternalAuth()
    }

    function setPassword(password) {
        GreetCore.GreetdState.passwordBuffer = password || ""
        if (!GreetCore.GreetdState.passwordBuffer) {
            root.passwordSubmitRequested = false
        }
    }

    function resetUser() {
        GreetCore.GreetdState.clearCredentials()
        root.clearAuthFeedback()
        root.passwordFailureCount = 0
        root.externalAuthAutoStartedForUser = ""
        root.awaitingExternalAuth = false
        root.pendingPasswordResponse = false
        root.resetPasswordSessionTransition(true)

        if (Greetd.state !== GreetdState.Inactive) {
            Greetd.cancelSession()
        }
    }

    function selectSessionByIndex(index) {
        if (index < 0 || index >= GreetCore.GreetdState.sessionList.length) {
            return
        }

        GreetCore.GreetdState.currentSessionIndex = index
        GreetCore.GreetdState.selectedSessionCommand = GreetCore.GreetdState.sessionExecs[index] || ""
        GreetCore.GreetdState.selectedSessionPath = GreetCore.GreetdState.sessionPaths[index] || ""
    }

    function selectSessionByPath(path) {
        const index = GreetCore.GreetdState.sessionPaths.indexOf(path)
        if (index >= 0) {
            root.selectSessionByIndex(index)
        }
    }

    function finalizeSessionSelection() {
        if (!GreetCore.GreetdState.sessionList.length || !GreetCore.GreetdMemory.memoryReady || !GreetCore.GreetdSettings.settingsLoaded) {
            return
        }

        const savedSession = GreetCore.GreetdSettings.rememberLastSession ? GreetCore.GreetdMemory.lastSessionId : ""
        if (savedSession) {
            const savedIndex = GreetCore.GreetdState.sessionPaths.indexOf(savedSession)
            if (savedIndex >= 0) {
                root.selectSessionByIndex(savedIndex)
                return
            }
        }

        root.selectSessionByIndex(0)
    }

    function submitBufferedPassword() {
        root.pendingPasswordResponse = false
        root.resetPasswordSessionTransition(true)
        root.awaitingExternalAuth = false
        authTimeout.interval = root.defaultAuthTimeoutMs
        authTimeout.restart()

        // some pam stacks only move forward once they receive a response, even if
        // the response is intentionally empty for fingerprint / u2f flows.
        Greetd.respond(GreetCore.GreetdState.passwordBuffer || "")
        GreetCore.GreetdState.clearPassword()
        return true
    }

    function startAuthSession(submitPassword) {
        submitPassword = submitPassword === true
        if (!GreetCore.GreetdState.username || GreetCore.GreetdState.unlocking) {
            return
        }

        const hasPasswordBuffer = GreetCore.GreetdState.passwordBuffer && GreetCore.GreetdState.passwordBuffer.length > 0
        if (Greetd.state !== GreetdState.Inactive) {
            if (root.pendingPasswordResponse && submitPassword) {
                root.submitBufferedPassword()
            } else if (submitPassword) {
                root.passwordSubmitRequested = true
            }
            return
        }

        if (root.cancelingExternalAuthForPassword) {
            if (submitPassword) {
                root.passwordSubmitRequested = true
            }
            return
        }

        if (!submitPassword && !hasPasswordBuffer && !root.supportsExternalAuth) {
            return
        }

        root.pendingPasswordResponse = false
        root.passwordSubmitRequested = submitPassword
        root.awaitingExternalAuth = !submitPassword && !hasPasswordBuffer && root.supportsExternalAuth
        const waitingOnExternalBeforePassword = submitPassword && root.supportsExternalAuth
        authTimeout.interval = (root.awaitingExternalAuth || waitingOnExternalBeforePassword)
            ? root.externalAuthTimeoutMs
            : root.defaultAuthTimeoutMs
        authTimeout.restart()
        Greetd.createSession(GreetCore.GreetdState.username)
    }

    function startPasswordAuth() {
        root.startAuthSession(true)
    }

    function startExternalAuth() {
        root.startAuthSession(false)
    }

    function maybeAutoStartExternalAuth() {
        if (!GreetCore.GreetdState.username || !root.supportsExternalAuth) {
            return
        }

        if (GreetCore.GreetdState.unlocking || Greetd.state !== GreetdState.Inactive) {
            return
        }

        if (root.passwordSubmitRequested || root.cancelingExternalAuthForPassword) {
            return
        }

        if (GreetCore.GreetdState.passwordBuffer && GreetCore.GreetdState.passwordBuffer.length > 0) {
            return
        }

        if (root.externalAuthAutoStartedForUser === GreetCore.GreetdState.username) {
            return
        }

        root.externalAuthAutoStartedForUser = GreetCore.GreetdState.username
        root.startAuthSession(false)
    }

    function addSession(path, name, execCommand) {
        if (!name || !execCommand || GreetCore.GreetdState.sessionList.includes(name)) {
            return
        }

        GreetCore.GreetdState.sessionList = GreetCore.GreetdState.sessionList.concat([name])
        GreetCore.GreetdState.sessionExecs = GreetCore.GreetdState.sessionExecs.concat([execCommand])
        GreetCore.GreetdState.sessionPaths = GreetCore.GreetdState.sessionPaths.concat([path])
    }

    function parseDesktopFile(content, path) {
        let name = ""
        let execCommand = ""
        const lines = content.split("\n")
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            if (!name && line.startsWith("Name=")) {
                name = line.substring(5).trim()
            } else if (!execCommand && line.startsWith("Exec=")) {
                execCommand = line.substring(5).trim()
            }

            if (name && execCommand) {
                break
            }
        }

        root.addSession(path, name, execCommand)
    }

    function loadDesktopFile(filePath) {
        if (root.pendingSessionFiles[filePath]) {
            return
        }

        root.pendingSessionFiles[filePath] = true
        root.pendingSessionCount = root.pendingSessionCount + 1
        desktopFileLoader.createObject(root, { filePath: filePath })
    }

    function onDesktopFileLoaded(filePath) {
        root.pendingSessionCount = root.pendingSessionCount - 1
        if (root.pendingSessionCount === 0) {
            Qt.callLater(root.finalizeSessionSelection)
        }
    }

    Component.onCompleted: {
        root.refreshPasswordAttemptPolicyHint()
        root.applyRememberedUser()
        fprintdDeviceProbe.running = true
    }

    Connections {
        target: GreetCore.GreetdSettings

        function onSettingsLoadedChanged() {
            if (GreetCore.GreetdSettings.settingsLoaded) {
                root.applyRememberedUser()
                root.finalizeSessionSelection()
            }
        }

        function onRememberLastUserChanged() {
            if (!GreetCore.GreetdSettings.rememberLastUser && GreetCore.GreetdMemory.lastSuccessfulUser) {
                GreetCore.GreetdMemory.setLastSuccessfulUser("")
            }
            root.applyRememberedUser()
        }

        function onRememberLastSessionChanged() {
            if (!GreetCore.GreetdSettings.rememberLastSession && GreetCore.GreetdMemory.lastSessionId) {
                GreetCore.GreetdMemory.setLastSessionId("")
            }
            root.finalizeSessionSelection()
        }
    }

    Connections {
        target: GreetCore.GreetdMemory

        function onLastSuccessfulUserChanged() {
            root.applyRememberedUser()
        }

        function onMemoryReadyChanged() {
            root.applyRememberedUser()
            root.finalizeSessionSelection()
        }
    }

    FileView {
        path: "/etc/pam.d/greetd"
        printErrors: false
        onLoaded: {
            root.greetdPamText = text()
            root.refreshPasswordAttemptPolicyHint()
            root.maybeAutoStartExternalAuth()
        }
        onLoadFailed: {
            root.greetdPamText = ""
            root.refreshPasswordAttemptPolicyHint()
        }
    }

    FileView {
        path: "/etc/pam.d/system-auth"
        printErrors: false
        onLoaded: {
            root.systemAuthPamText = text()
            root.refreshPasswordAttemptPolicyHint()
            root.maybeAutoStartExternalAuth()
        }
        onLoadFailed: {
            root.systemAuthPamText = ""
            root.refreshPasswordAttemptPolicyHint()
        }
    }

    FileView {
        path: "/etc/pam.d/common-auth"
        printErrors: false
        onLoaded: {
            root.commonAuthPamText = text()
            root.refreshPasswordAttemptPolicyHint()
            root.maybeAutoStartExternalAuth()
        }
        onLoadFailed: {
            root.commonAuthPamText = ""
            root.refreshPasswordAttemptPolicyHint()
        }
    }

    FileView {
        path: "/etc/pam.d/password-auth"
        printErrors: false
        onLoaded: {
            root.passwordAuthPamText = text()
            root.refreshPasswordAttemptPolicyHint()
            root.maybeAutoStartExternalAuth()
        }
        onLoadFailed: {
            root.passwordAuthPamText = ""
            root.refreshPasswordAttemptPolicyHint()
        }
    }

    FileView {
        path: "/etc/pam.d/system-login"
        printErrors: false
        onLoaded: {
            root.systemLoginPamText = text()
            root.refreshPasswordAttemptPolicyHint()
            root.maybeAutoStartExternalAuth()
        }
        onLoadFailed: {
            root.systemLoginPamText = ""
            root.refreshPasswordAttemptPolicyHint()
        }
    }

    FileView {
        path: "/etc/pam.d/system-local-login"
        printErrors: false
        onLoaded: {
            root.systemLocalLoginPamText = text()
            root.refreshPasswordAttemptPolicyHint()
            root.maybeAutoStartExternalAuth()
        }
        onLoadFailed: {
            root.systemLocalLoginPamText = ""
            root.refreshPasswordAttemptPolicyHint()
        }
    }

    FileView {
        path: "/etc/pam.d/common-auth-pc"
        printErrors: false
        onLoaded: {
            root.commonAuthPcPamText = text()
            root.refreshPasswordAttemptPolicyHint()
            root.maybeAutoStartExternalAuth()
        }
        onLoadFailed: {
            root.commonAuthPcPamText = ""
            root.refreshPasswordAttemptPolicyHint()
        }
    }

    FileView {
        path: "/etc/pam.d/login"
        printErrors: false
        onLoaded: {
            root.loginPamText = text()
            root.refreshPasswordAttemptPolicyHint()
            root.maybeAutoStartExternalAuth()
        }
        onLoadFailed: {
            root.loginPamText = ""
            root.refreshPasswordAttemptPolicyHint()
        }
    }

    FileView {
        path: "/etc/security/faillock.conf"
        printErrors: false
        onLoaded: {
            root.faillockConfigText = text()
            root.refreshPasswordAttemptPolicyHint()
        }
        onLoadFailed: {
            root.faillockConfigText = ""
            root.refreshPasswordAttemptPolicyHint()
        }
    }

    Process {
        id: fprintdDeviceProbe
        running: false
        command: [
            "sh",
            "-c",
            "command -v gdbus >/dev/null 2>&1 || { echo PROBE_UNAVAILABLE; exit 0; }; " +
            "gdbus call --system " +
            "--dest net.reactivated.Fprint " +
            "--object-path /net/reactivated/Fprint/Manager " +
            "--method net.reactivated.Fprint.Manager.GetDevices 2>/dev/null " +
            "|| echo PROBE_UNAVAILABLE",
        ]

        stdout: StdioCollector {
            onStreamFinished: {
                if (text.includes("PROBE_UNAVAILABLE")) {
                    return
                }

                root.fprintdHasDevice = text.includes("objectpath")
                root.fprintdProbeComplete = true
                root.maybeAutoStartExternalAuth()
            }
        }

        onExited: function(exitCode, exitStatus) {
            if (!root.fprintdProbeComplete) {
                root.maybeAutoStartExternalAuth()
            }
        }
    }

    Component {
        id: desktopFileLoader

        FileView {
            id: desktopFile
            property string filePath: ""
            path: filePath

            onLoaded: {
                root.parseDesktopFile(text(), filePath)
                root.onDesktopFileLoaded(filePath)
                desktopFile.destroy()
            }

            onLoadFailed: {
                root.onDesktopFileLoaded(filePath)
                desktopFile.destroy()
            }
        }
    }

    Repeater {
        model: root.sessionDirs

        Item {
            required property string modelData

            FolderListModel {
                folder: root.encodeFileUrl(modelData)
                nameFilters: ["*.desktop"]
                showDirs: false
                showDotAndDotDot: false

                onStatusChanged: {
                    if (status !== FolderListModel.Ready) {
                        return
                    }

                    for (let i = 0; i < count; i++) {
                        let filePath = get(i, "filePath")
                        if (filePath.startsWith("file://")) {
                            filePath = filePath.substring(7)
                        }
                        root.loadDesktopFile(filePath)
                    }
                }
            }
        }
    }

    Connections {
        target: Greetd

        function onAuthMessage(message, error, responseRequired, echoResponse) {
            if (responseRequired) {
                root.cancelingExternalAuthForPassword = false
                root.passwordSessionTransitionRetryCount = 0
                root.awaitingExternalAuth = false
                root.pendingPasswordResponse = true

                const hasPasswordBuffer = GreetCore.GreetdState.passwordBuffer && GreetCore.GreetdState.passwordBuffer.length > 0
                if (!root.passwordSubmitRequested && hasPasswordBuffer) {
                    root.passwordSubmitRequested = true
                }

                if (root.passwordSubmitRequested && !root.submitBufferedPassword()) {
                    root.passwordSubmitRequested = false
                }

                if (root.passwordSubmitRequested || hasPasswordBuffer) {
                    authTimeout.interval = root.defaultAuthTimeoutMs
                    authTimeout.restart()
                } else {
                    authTimeout.stop()
                }
                return
            }

            root.pendingPasswordResponse = false
            const externalPrompt = !responseRequired
            if (!root.passwordSubmitRequested) {
                root.awaitingExternalAuth = root.supportsExternalAuth && externalPrompt
            }

            if (root.awaitingExternalAuth || (root.passwordSubmitRequested && externalPrompt && (root.pamHasFingerprint || root.pamHasU2f))) {
                authTimeout.interval = root.externalAuthTimeoutMs
            } else {
                authTimeout.interval = root.defaultAuthTimeoutMs
            }

            authTimeout.restart()
            Greetd.respond("")
        }

        function onStateChanged() {
            if (Greetd.state !== GreetdState.Inactive) {
                return
            }

            const resumePasswordSubmit = root.cancelingExternalAuthForPassword && root.passwordSubmitRequested
            root.awaitingExternalAuth = false
            root.pendingPasswordResponse = false
            root.cancelingExternalAuthForPassword = false
            authTimeout.interval = root.defaultAuthTimeoutMs
            authTimeout.stop()

            if (resumePasswordSubmit) {
                Qt.callLater(function() {
                    root.startPasswordAuth()
                })
                return
            }

            root.resetPasswordSessionTransition(true)
        }

        function onReadyToLaunch() {
            root.awaitingExternalAuth = false
            root.pendingPasswordResponse = false
            root.resetPasswordSessionTransition(true)
            authTimeout.interval = root.defaultAuthTimeoutMs
            authTimeout.stop()
            root.passwordFailureCount = 0
            root.clearAuthFeedback()

            const sessionCommand = GreetCore.GreetdState.selectedSessionCommand || GreetCore.GreetdState.sessionExecs[GreetCore.GreetdState.currentSessionIndex]
            const sessionPath = GreetCore.GreetdState.selectedSessionPath || GreetCore.GreetdState.sessionPaths[GreetCore.GreetdState.currentSessionIndex]
            if (!sessionCommand) {
                root.authPhase = "error"
                root.authFeedbackMessage = "selected session is unavailable"
                return
            }

            GreetCore.GreetdState.unlocking = true
            launchTimeout.restart()

            if (GreetCore.GreetdSettings.rememberLastSession) {
                GreetCore.GreetdMemory.setLastSessionId(sessionPath)
            } else if (GreetCore.GreetdMemory.lastSessionId) {
                GreetCore.GreetdMemory.setLastSessionId("")
            }

            if (GreetCore.GreetdSettings.rememberLastUser) {
                GreetCore.GreetdMemory.setLastSuccessfulUser(GreetCore.GreetdState.username)
            } else if (GreetCore.GreetdMemory.lastSuccessfulUser) {
                GreetCore.GreetdMemory.setLastSuccessfulUser("")
            }

            root.pendingLaunchCommand = sessionCommand
            root.pendingLaunchEnv = ["XDG_SESSION_TYPE=" + GreetCore.GreetdSettings.sessionType]
            memoryFlushTimer.restart()
        }

        function onAuthFailure(message) {
            root.awaitingExternalAuth = false
            root.pendingPasswordResponse = false
            root.resetPasswordSessionTransition(true)
            authTimeout.interval = root.defaultAuthTimeoutMs
            authTimeout.stop()
            launchTimeout.stop()
            GreetCore.GreetdState.unlocking = false

            if (GreetdPam.isLikelyLockoutMessage(message)) {
                root.authPhase = "max"
            } else {
                root.authPhase = "fail"
                root.passwordFailureCount = root.passwordFailureCount + 1
            }

            root.authFeedbackMessage = root.currentAuthMessage()
            GreetCore.GreetdState.clearPassword()
            Greetd.cancelSession()
        }

        function onError(error) {
            root.awaitingExternalAuth = false
            root.pendingPasswordResponse = false
            root.resetPasswordSessionTransition(true)
            authTimeout.interval = root.defaultAuthTimeoutMs
            authTimeout.stop()
            launchTimeout.stop()
            GreetCore.GreetdState.unlocking = false
            root.authPhase = "error"
            root.authFeedbackMessage = root.currentAuthMessage()
            GreetCore.GreetdState.clearPassword()
            Greetd.cancelSession()
        }
    }

    Timer {
        id: memoryFlushTimer
        interval: root.memoryFlushDelayMs
        onTriggered: {
            if (!root.pendingLaunchCommand) {
                return
            }

            const sessionCommand = root.pendingLaunchCommand
            const launchEnv = root.pendingLaunchEnv
            root.pendingLaunchCommand = ""
            root.pendingLaunchEnv = []

            // keep launch semantics identical to the existing greeter while the
            // extraction is in flight. desktop Exec parsing is its own problem.
            Greetd.launch(sessionCommand.split(" "), launchEnv)
        }
    }

    Timer {
        id: authTimeout
        interval: root.defaultAuthTimeoutMs
        onTriggered: {
            if (GreetCore.GreetdState.unlocking || Greetd.state === GreetdState.Inactive) {
                return
            }

            root.awaitingExternalAuth = false
            root.pendingPasswordResponse = false
            root.resetPasswordSessionTransition(true)
            authTimeout.interval = root.defaultAuthTimeoutMs
            root.authPhase = "error"
            root.authFeedbackMessage = root.currentAuthMessage()
            GreetCore.GreetdState.clearPassword()
            Greetd.cancelSession()
        }
    }

    Timer {
        id: launchTimeout
        interval: 8000
        onTriggered: {
            if (!GreetCore.GreetdState.unlocking) {
                return
            }

            root.pendingPasswordResponse = false
            root.resetPasswordSessionTransition(true)
            GreetCore.GreetdState.unlocking = false
            root.authPhase = "error"
            root.authFeedbackMessage = "session launch timed out"
            Greetd.cancelSession()
        }
    }
}
