import Quickshell
import QtQuick
import QtQuick.Effects

import "design" as Design
import "greetd" as Greet

/**
 * wallpaper-first greeter with almost no chrome.
 *
 * why: this host only has one real user, so naming login mechanics on screen is
 * redundant. keep one small frosted pill for the rare case where fingerprint
 * needs keyboard fallback.
 */
ShellRoot {
    id: root

    readonly property bool passwordVisible: Greet.GreetdState.passwordBuffer.length > 0
        || controller.authState === "fail"
        || controller.authState === "error"
        || controller.authState === "max"
        || controller.pendingPasswordResponse
    readonly property int pillPaddingX: 4
    readonly property int pillPaddingY: 2

    function ensurePrimaryUser() {
        if (!Greet.GreetdState.username) {
            controller.setUsername("bdsqqq")
        }
    }

    function focusPasswordIfNeeded() {
        if (root.passwordVisible) {
            passwordInput.forceActiveFocus()
        }
    }

    Greet.GreetdController {
        id: controller
    }

    FloatingWindow {
        id: greeterWindow

        visible: true
        implicitWidth: 1280
        implicitHeight: 800
        color: Design.Theme.t.black
        title: "greeter"

        Component.onCompleted: {
            root.ensurePrimaryUser()
            Qt.callLater(root.focusPasswordIfNeeded)
        }

        Image {
            id: wallpaper
            anchors.fill: parent
            source: "file:///etc/wallpaper.jpg"
            fillMode: Image.PreserveAspectCrop
            asynchronous: true
            cache: true
            smooth: true
        }

        Rectangle {
            anchors.fill: parent
            color: "#12000000"
        }

        Item {
            id: pillShell
            anchors.centerIn: parent
            visible: root.passwordVisible
            implicitWidth: pillContent.implicitWidth + root.pillPaddingX * 2
            implicitHeight: pillContent.implicitHeight + root.pillPaddingY * 2

            Rectangle {
                id: pillMask
                anchors.fill: parent
                radius: height / 2
                color: "#01ffffff"
                visible: false
            }

            ShaderEffectSource {
                id: wallpaperSource
                anchors.fill: pillMask
                sourceItem: wallpaper
                sourceRect: Qt.rect(pillShell.x, pillShell.y, pillShell.width, pillShell.height)
                live: true
                hideSource: false
                visible: false
            }

            MultiEffect {
                anchors.fill: pillMask
                source: wallpaperSource
                maskEnabled: true
                maskSource: pillMask
                blurEnabled: true
                blurMax: 24
                blurMultiplier: 1.0
                autoPaddingEnabled: false
            }

            Rectangle {
                anchors.fill: parent
                radius: height / 2
                color: "#14ffffff"
                border.color: "#99ffffff"
                border.width: 1
            }

            Rectangle {
                anchors.fill: parent
                anchors.margins: 1
                radius: height / 2 - 1
                color: "transparent"
                border.color: "#33ffffff"
                border.width: 1
            }

            Item {
                id: pillContent
                anchors.centerIn: parent
                implicitWidth: passwordInput.implicitWidth + submitHit.implicitWidth + 10
                implicitHeight: Math.max(passwordInput.implicitHeight, submitHit.implicitHeight)

                TextInput {
                    id: passwordInput

                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    width: 120
                    height: 18
                    color: Design.Theme.t.white
                    font.family: "Inter"
                    font.pixelSize: 14
                    font.weight: Font.Medium
                    selectionColor: "#66ffffff"
                    selectedTextColor: Design.Theme.t.black
                    verticalAlignment: TextInput.AlignVCenter
                    echoMode: TextInput.Password
                    text: Greet.GreetdState.passwordBuffer

                    onTextEdited: controller.setPassword(text)
                    onAccepted: controller.startPasswordAuth()
                }

                Item {
                    id: submitHit
                    anchors.left: passwordInput.right
                    anchors.leftMargin: 10
                    anchors.verticalCenter: parent.verticalCenter
                    implicitWidth: 16
                    implicitHeight: 16

                    Text {
                        anchors.centerIn: parent
                        text: controller.busy ? "…" : "→"
                        color: "#f2ffffff"
                        font.family: "Inter"
                        font.pixelSize: 14
                        font.weight: Font.Medium
                    }

                    MouseArea {
                        anchors.fill: parent
                        enabled: !controller.busy
                        onClicked: controller.startPasswordAuth()
                    }
                }
            }
        }

        MouseArea {
            anchors.fill: parent
            enabled: !root.passwordVisible && !controller.busy
            onPressed: controller.startPasswordAuth()
        }

        Connections {
            target: Greet.GreetdState

            function onUsernameChanged() {
                root.ensurePrimaryUser()
            }
        }

        Connections {
            target: controller

            function onAuthStateChanged() {
                if (root.passwordVisible) {
                    Qt.callLater(root.focusPasswordIfNeeded)
                }
            }
        }
    }
}
