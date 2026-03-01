// Theme.qml
// Singleton providing convenient access to design tokens.
// Why: 't.color' is terse and reduces visual noise vs 'Tokens.color' everywhere.
//      single import point for all design constants.

pragma Singleton
import QtQuick

QtObject {
    id: root

    // expose tokens as 't' for terse access: Theme.t.c.fg, Theme.t.space.2, etc.
    property var t: Tokens {}
}
