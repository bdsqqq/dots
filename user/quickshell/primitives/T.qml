// T.qml
// Text primitive wrapping Theme tokens.
// why: centralizes typography decisions (font family, color tones, sizing) in one place.
//      prevents hardcoded font.pixelSize and color values scattered through components.
//
// @prop tone - semantic color: "fg" | "muted" | "subtle"
// @prop size - semantic size: "bodySm" | "bodyMd" | "titleLg"
// @prop text - the string to display

import QtQuick
import "../design/Theme.qml" as Theme

Text {
    id: root

    property string tone: "fg"
    property string size: "bodyMd"
    property string text: ""

    // default font family for the entire shell
    font.family: "Berkeley Mono"

    // map semantic tone to theme color
    color: {
        switch (tone) {
            case "fg": return Theme.t.c.fg
            case "muted": return Theme.t.c.muted
            case "subtle": return Theme.t.c.subtle
            default: return Theme.t.c.fg
        }
    }

    // map semantic size to theme typography
    font.pixelSize: {
        switch (size) {
            case "bodySm": return Theme.t.type.bodySm
            case "bodyMd": return Theme.t.type.bodyMd
            case "titleLg": return Theme.t.type.titleLg
            default: return Theme.t.type.bodyMd
        }
    }

    // bind the text property
    text: root.text
}
