// Theme.qml
// Singleton providing convenient access to design tokens.
// Why: 't.color' is terse and reduces visual noise vs 'Tokens.color' everywhere.
//      single import point for all design constants.
// Note: Tokens is also a singleton; we re-export its properties via 't' for API consistency.

pragma Singleton
import QtQuick

QtObject {
    id: root

    // re-export all token properties via 't' namespace
    // why: keeps the API consistent - consumers use Theme.t.* for all tokens
    property var t: Tokens
}
