// Theme.qml
// Singleton providing convenient access to design tokens.
// Why: 't.color' is terse and reduces visual noise vs 'Tokens.color' everywhere.
//      single import point for all design constants.

pragma Singleton
import QtQuick

Tokens {
    id: t
}
