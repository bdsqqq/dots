pragma Singleton

// Theme.qml
// Singleton providing convenient access to design tokens.
// Why: 't.color' is terse and reduces visual noise vs 'Tokens.color' everywhere.
//      single import point for all design constants.

import QtQuick

QtObject {
    id: root

    // expose tokens as 't' for terse access: Theme.t.fg, Theme.t.space2, etc.
    readonly property Tokens t: Tokens
}
