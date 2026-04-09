pragma Singleton

/**
 * narrows settings to the bits that change auth behavior.
 *
 * why this is tiny: theming and layout churn constantly, but remember-policy
 * and external-auth switches need a stable contract if multiple frontends are
 * going to share one backend.
 */
import QtQuick
import Quickshell
import Quickshell.Io
import "GreetdEnv.js" as GreetdEnv

Item {
    id: root

    visible: false
    width: 0
    height: 0

    readonly property string configDir: Quickshell.env("QS_GREETD_CFG_DIR") || Quickshell.env("DMS_GREET_CFG_DIR") || "/var/cache/quickshell-greetd"
    readonly property string settingsPath: configDir + "/settings.json"

    property bool settingsLoaded: false
    property bool rememberLastSession: true
    property bool rememberLastUser: true
    property bool enableFingerprint: false
    property bool enableU2f: false
    property string sessionType: "wayland"

    function parseSettings(content) {
        try {
            let settings = {}
            if (content && content.trim()) {
                settings = JSON.parse(content)
            }

            const rememberLastSessionOverride = GreetdEnv.readBoolOverride(
                Quickshell.env,
                ["QS_GREETD_REMEMBER_LAST_SESSION", "DMS_GREET_REMEMBER_LAST_SESSION", "DMS_SAVE_SESSION"],
                undefined,
            )
            const rememberLastUserOverride = GreetdEnv.readBoolOverride(
                Quickshell.env,
                ["QS_GREETD_REMEMBER_LAST_USER", "DMS_GREET_REMEMBER_LAST_USER", "DMS_SAVE_USERNAME"],
                undefined,
            )
            const fingerprintOverride = GreetdEnv.readBoolOverride(
                Quickshell.env,
                ["QS_GREETD_ENABLE_FINGERPRINT", "QS_GREETD_ENABLE_FPRINT"],
                undefined,
            )
            const u2fOverride = GreetdEnv.readBoolOverride(
                Quickshell.env,
                ["QS_GREETD_ENABLE_U2F"],
                undefined,
            )
            const sessionTypeOverride = GreetdEnv.firstDefined(
                Quickshell.env,
                ["QS_GREETD_SESSION_TYPE"],
            )

            if (rememberLastSessionOverride !== undefined) {
                root.rememberLastSession = rememberLastSessionOverride
            } else {
                root.rememberLastSession = settings.rememberLastSession !== undefined
                    ? settings.rememberLastSession
                    : settings.greeterRememberLastSession !== undefined
                        ? settings.greeterRememberLastSession
                        : true
            }

            if (rememberLastUserOverride !== undefined) {
                root.rememberLastUser = rememberLastUserOverride
            } else {
                root.rememberLastUser = settings.rememberLastUser !== undefined
                    ? settings.rememberLastUser
                    : settings.greeterRememberLastUser !== undefined
                        ? settings.greeterRememberLastUser
                        : true
            }

            if (fingerprintOverride !== undefined) {
                root.enableFingerprint = fingerprintOverride
            } else {
                root.enableFingerprint = settings.enableFingerprint !== undefined
                    ? settings.enableFingerprint
                    : settings.greeterEnableFingerprint !== undefined
                        ? settings.greeterEnableFingerprint
                        : settings.greeterEnableFprint !== undefined
                            ? settings.greeterEnableFprint
                            : false
            }

            if (u2fOverride !== undefined) {
                root.enableU2f = u2fOverride
            } else {
                root.enableU2f = settings.enableU2f !== undefined
                    ? settings.enableU2f
                    : settings.greeterEnableU2f !== undefined
                        ? settings.greeterEnableU2f
                        : false
            }

            if (sessionTypeOverride !== undefined) {
                root.sessionType = sessionTypeOverride
            } else {
                root.sessionType = settings.sessionType !== undefined ? settings.sessionType : "wayland"
            }
        } catch (error) {
            console.warn("failed to load greetd settings:", error)
        } finally {
            root.settingsLoaded = true
        }
    }

    FileView {
        id: settingsFile
        path: root.settingsPath
        blockLoading: false
        blockWrites: true
        atomicWrites: false
        watchChanges: false
        printErrors: true
    }

    Connections {
        target: settingsFile

        function onLoaded() {
            root.parseSettings(settingsFile.text())
        }

        function onLoadFailed(error) {
            root.parseSettings("")
        }
    }
}
