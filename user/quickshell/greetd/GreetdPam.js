.pragma library

var defaultLockoutAttemptHint = 3

function stripComment(line) {
    if (!line) {
        return ""
    }

    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
        return ""
    }

    const hashIndex = trimmed.indexOf("#")
    if (hashIndex >= 0) {
        return trimmed.substring(0, hashIndex).trim()
    }

    return trimmed
}

function moduleEnabled(pamText, moduleName) {
    if (!pamText || !moduleName) {
        return false
    }

    const lines = pamText.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
        const line = stripComment(lines[i])
        if (!line) {
            continue
        }

        if (line.includes(moduleName)) {
            return true
        }
    }

    return false
}

function textIncludesFile(pamText, filename) {
    if (!pamText || !filename) {
        return false
    }

    const lines = pamText.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
        const line = stripComment(lines[i])
        if (!line) {
            continue
        }

        if (line.includes(filename) && (line.includes("include") || line.includes("substack") || line.startsWith("@include"))) {
            return true
        }
    }

    return false
}

function stackHasModule(greetdPamText, includedStacks, moduleName) {
    if (moduleEnabled(greetdPamText, moduleName)) {
        return true
    }

    for (let i = 0; i < includedStacks.length; i++) {
        const stack = includedStacks[i]
        if (textIncludesFile(greetdPamText, stack[0]) && moduleEnabled(stack[1], moduleName)) {
            return true
        }
    }

    return false
}

function usesLockoutPolicy(pamText) {
    if (!pamText) {
        return false
    }

    const lines = pamText.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
        const line = stripComment(lines[i])
        if (!line) {
            continue
        }

        if (line.includes("pam_faillock.so") || line.includes("pam_tally2.so") || line.includes("pam_tally.so")) {
            return true
        }
    }

    return false
}

function parsePamDenyValue(pamText) {
    if (!pamText) {
        return -1
    }

    const lines = pamText.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
        const line = stripComment(lines[i])
        if (!line) {
            continue
        }

        if (!line.includes("pam_faillock.so") && !line.includes("pam_tally2.so") && !line.includes("pam_tally.so")) {
            continue
        }

        const denyMatch = line.match(/\bdeny\s*=\s*(\d+)\b/i)
        if (!denyMatch) {
            continue
        }

        const parsed = parseInt(denyMatch[1], 10)
        if (!isNaN(parsed)) {
            return parsed
        }
    }

    return -1
}

function parseFaillockDenyValue(configText) {
    if (!configText) {
        return -1
    }

    const lines = configText.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
        const line = stripComment(lines[i])
        if (!line) {
            continue
        }

        const denyMatch = line.match(/^deny\s*=\s*(\d+)\s*$/i)
        if (!denyMatch) {
            continue
        }

        const parsed = parseInt(denyMatch[1], 10)
        if (!isNaN(parsed)) {
            return parsed
        }
    }

    return -1
}

function inferPasswordAttemptLimit(pamSources, faillockConfigText) {
    let lockoutConfigured = false
    let denyFromPam = -1

    for (let i = 0; i < pamSources.length; i++) {
        const source = pamSources[i]
        if (!source) {
            continue
        }

        if (usesLockoutPolicy(source)) {
            lockoutConfigured = true
        }

        const denyValue = parsePamDenyValue(source)
        if (denyValue >= 0 && (denyFromPam < 0 || denyValue < denyFromPam)) {
            denyFromPam = denyValue
        }
    }

    if (!lockoutConfigured) {
        return 0
    }

    const denyFromConfig = parseFaillockDenyValue(faillockConfigText)
    if (denyFromConfig >= 0) {
        return denyFromConfig
    }

    if (denyFromPam >= 0) {
        return denyFromPam
    }

    return defaultLockoutAttemptHint
}

function isLikelyLockoutMessage(message) {
    const lower = (message || "").toLowerCase()
    return lower.includes("account is locked") || lower.includes("too many") || lower.includes("maximum number of") || lower.includes("auth_err")
}
