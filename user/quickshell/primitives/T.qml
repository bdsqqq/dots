// T.qml
// Text primitive wrapping Theme tokens.
// why: centralizes typography decisions (font family, color tones, sizing) in one place.
//      prevents hardcoded font.pixelSize and color values scattered through components.
//
// @prop tone - semantic color: "fg" | "muted" | "subtle"
// @prop size - semantic size: "bodySm" | "bodyMd" | "titleLg"

import QtQuick
import "../design" as Design

Text {
    id: root

    property string tone: "fg"
    property string size: "bodyMd"

    // default font family for the entire shell
    font.family: "Berkeley Mono"

    // map semantic tone to theme color
    color: {
        switch (tone) {
            case "fg": return Design.Theme.t.c.fg
            case "muted": return Design.Theme.t.c.muted
            case "subtle": return Design.Theme.t.c.subtle
            default: return Design.Theme.t.c.fg
        }
    }

    // map semantic size to theme typography
    font.pixelSize: {
        switch (size) {
            case "bodySm": return Design.Theme.t.type.bodySm
            case "bodyMd": return Design.Theme.t.type.bodyMd
            case "titleLg": return Design.Theme.t.type.titleLg
            default: return Design.Theme.t.type.bodyMd
        }
    }
}
