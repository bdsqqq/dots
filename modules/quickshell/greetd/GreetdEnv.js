.pragma library

function firstDefined(readEnv, names) {
    for (let i = 0; i < names.length; i++) {
        const value = readEnv(names[i])
        if (value !== undefined && value !== null && value !== "") {
            return value
        }
    }

    return undefined
}

function readBoolOverride(readEnv, names, fallback) {
    const raw = firstDefined(readEnv, names)
    if (raw === undefined) {
        return fallback
    }

    const normalized = String(raw).trim().toLowerCase()
    if (["1", "true", "yes", "on"].indexOf(normalized) >= 0) {
        return true
    }

    if (["0", "false", "no", "off"].indexOf(normalized) >= 0) {
        return false
    }

    return fallback
}
