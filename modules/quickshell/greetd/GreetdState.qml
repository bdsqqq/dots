pragma Singleton

/**
 * keeps the mutable login model in one place so skins can be replaced without
 * moving auth state through random text inputs and callbacks.
 *
 * the controller owns protocol sequencing. frontends own presentation and feed
 * user intent into this state via controller methods.
 */
import QtQuick

QtObject {
    id: root

    property string username: ""
    property string passwordBuffer: ""
    property bool unlocking: false

    property var sessionList: []
    property var sessionExecs: []
    property var sessionPaths: []
    property int currentSessionIndex: 0
    property string selectedSessionCommand: ""
    property string selectedSessionPath: ""

    function clearPassword() {
        passwordBuffer = ""
    }

    function clearCredentials() {
        username = ""
        passwordBuffer = ""
        unlocking = false
    }

    function resetSessions() {
        sessionList = []
        sessionExecs = []
        sessionPaths = []
        currentSessionIndex = 0
        selectedSessionCommand = ""
        selectedSessionPath = ""
    }
}
