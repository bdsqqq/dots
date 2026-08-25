// T.qml
// Text primitive wrapping Theme tokens.
// why: centralizes typography decisions (font family, color tones, sizing) in one place.
//      prevents hardcoded font.pixelSize and color values scattered through components.
//
// @prop tone - semantic color: "fg" | "bg" | "muted" | "subtle"
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
            case "fg": return Design.Theme.t.fg
            case "bg": return Design.Theme.t.black
            case "muted": return Design.Theme.t.muted
            case "subtle": return Design.Theme.t.subtle
            default: return Design.Theme.t.fg
        }
    }

    // map semantic size to theme typography
    font.pixelSize: {
        switch (size) {
            case "bodySm": return Design.Theme.t.bodySm
            case "bodyMd": return Design.Theme.t.bodyMd
            case "titleLg": return Design.Theme.t.titleLg
            default: return Design.Theme.t.bodyMd
        }
    }
}
