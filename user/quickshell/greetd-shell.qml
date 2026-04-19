import Quickshell
import QtQuick
import QtQuick.Layouts

import "design" as Design
import "primitives" as Primitives
import "controls" as Controls
import "greetd" as Greet

/**
 * this is a throwaway-looking first frontend on purpose.
 *
 * why: the one thing we cannot afford here is coupling a risky greetd rollout to
 * a bunch of unresolved visual decisions. prove the contract, keep the surface
 * boring, then get fancy once the login path survives real boots.
 */
ShellRoot {
    id: root

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

        Rectangle {
            anchors.fill: parent
            color: "#0f1115"
        }

        ColumnLayout {
            anchors.centerIn: parent
            width: 420
            spacing: Design.Theme.t.space4

            Primitives.T {
                Layout.alignment: Qt.AlignHCenter
                text: "welcome back"
                size: "titleLg"
            }

            Primitives.T {
                Layout.alignment: Qt.AlignHCenter
                text: controller.currentSessionName ? ("session: " + controller.currentSessionName) : "loading sessions..."
                tone: "muted"
                size: "bodySm"
            }

            Primitives.Surface {
                Layout.fillWidth: true
                implicitHeight: 52
                showBorder: usernameInput.activeFocus

                TextInput {
                    id: usernameInput

                    anchors.fill: parent
                    anchors.leftMargin: Design.Theme.t.space4
                    anchors.rightMargin: Design.Theme.t.space4
                    color: Design.Theme.t.fg
                    font.family: "Berkeley Mono"
                    font.pixelSize: Design.Theme.t.bodyMd
                    selectionColor: Design.Theme.t.gray500
                    selectedTextColor: Design.Theme.t.white
                    verticalAlignment: TextInput.AlignVCenter
                    text: Greet.GreetdState.username

                    onTextEdited: controller.setUsername(text)
                    onAccepted: passwordInput.forceActiveFocus()

                    Component.onCompleted: forceActiveFocus()
                }

                Primitives.T {
                    anchors.left: parent.left
                    anchors.leftMargin: Design.Theme.t.space4
                    anchors.verticalCenter: parent.verticalCenter
                    text: "username"
                    tone: "subtle"
                    visible: usernameInput.text.length === 0 && !usernameInput.activeFocus
                }
            }

            Primitives.Surface {
                Layout.fillWidth: true
                implicitHeight: 52
                showBorder: passwordInput.activeFocus

                TextInput {
                    id: passwordInput

                    anchors.fill: parent
                    anchors.leftMargin: Design.Theme.t.space4
                    anchors.rightMargin: Design.Theme.t.space4
                    color: Design.Theme.t.fg
                    font.family: "Berkeley Mono"
                    font.pixelSize: Design.Theme.t.bodyMd
                    selectionColor: Design.Theme.t.gray500
                    selectedTextColor: Design.Theme.t.white
                    verticalAlignment: TextInput.AlignVCenter
                    echoMode: TextInput.Password
                    text: Greet.GreetdState.passwordBuffer

                    onTextEdited: controller.setPassword(text)
                    onAccepted: controller.startPasswordAuth()
                }

                Primitives.T {
                    anchors.left: parent.left
                    anchors.leftMargin: Design.Theme.t.space4
                    anchors.verticalCenter: parent.verticalCenter
                    text: "password"
                    tone: "subtle"
                    visible: passwordInput.text.length === 0 && !passwordInput.activeFocus
                }
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: Design.Theme.t.space2

                Controls.Button {
                    Layout.fillWidth: true
                    variant: "outline"
                    text: controller.supportsFingerprint ? "fingerprint" : (controller.supportsU2f ? "u2f" : "external auth")
                    enabled: controller.supportsExternalAuth && !controller.busy
                    onClicked: controller.startExternalAuth()
                }

                Controls.Button {
                    Layout.fillWidth: true
                    variant: "fill"
                    text: controller.busy ? "working..." : "login"
                    enabled: !controller.busy
                    onClicked: controller.startPasswordAuth()
                }
            }

            Controls.Button {
                Layout.fillWidth: true
                variant: "ghost"
                text: "switch user"
                enabled: !controller.busy
                onClicked: {
                    controller.resetUser()
                    usernameInput.forceActiveFocus()
                }
            }

            Primitives.T {
                Layout.fillWidth: true
                text: controller.authFeedback
                tone: controller.authState === "" ? "muted" : "fg"
                wrapMode: Text.WordWrap
                horizontalAlignment: Text.AlignHCenter
                visible: text.length > 0
            }
        }
    }
}
