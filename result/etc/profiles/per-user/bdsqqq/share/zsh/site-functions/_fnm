#compdef fnm

autoload -U is-at-least

_fnm() {
    typeset -A opt_args
    typeset -a _arguments_options
    local ret=1

    if is-at-least 5.2; then
        _arguments_options=(-s -S -C)
    else
        _arguments_options=(-s -C)
    fi

    local context curcontext="$curcontext" state line
    _arguments "${_arguments_options[@]}" : \
'--node-dist-mirror=[<https\://nodejs.org/dist/> mirror]:NODE_DIST_MIRROR: ' \
'--fnm-dir=[The root directory of fnm installations]:BASE_DIR:_files' \
'--multishell-path=[Where the current node version link is stored. This value will be populated automatically by evaluating \`fnm env\` in your shell profile. Read more about it using \`fnm help env\`]:MULTISHELL_PATH:_files' \
'--log-level=[The log level of fnm commands]:LOG_LEVEL:(quiet error info)' \
'--arch=[Override the architecture of the installed Node binary. Defaults to arch of fnm binary]:ARCH: ' \
'--version-file-strategy=[A strategy for how to resolve the Node version. Used whenever \`fnm use\` or \`fnm install\` is called without a version, or when \`--use-on-cd\` is configured on evaluation]:VERSION_FILE_STRATEGY:((local\:"Use the local version of Node defined within the current directory"
recursive\:"Use the version of Node defined within the current directory and all parent directories"))' \
'--resolve-engines=[Resolve \`engines.node\` field in \`package.json\` whenever a \`.node-version\` or \`.nvmrc\` file is not present. This feature is enabled by default. To disable it, provide \`--resolve-engines=false\`.]' \
'--corepack-enabled[Enable corepack support for each new installation. This will make fnm call \`corepack enable\` on every Node.js installation. For more information about corepack see <https\://nodejs.org/api/corepack.html>]' \
'-h[Print help (see more with '\''--help'\'')]' \
'--help[Print help (see more with '\''--help'\'')]' \
'-V[Print version]' \
'--version[Print version]' \
":: :_fnm_commands" \
"*::: :->fnm" \
&& ret=0
    case $state in
    (fnm)
        words=($line[1] "${words[@]}")
        (( CURRENT += 1 ))
        curcontext="${curcontext%:*:*}:fnm-command-$line[1]:"
        case $line[1] in
            (list-remote)
_arguments "${_arguments_options[@]}" : \
'--filter=[Filter versions by a user-defined version or a semver range]:FILTER: ' \
'--lts=[Show only LTS versions (optionally filter by LTS codename)]' \
'--sort=[Version sorting order]:SORT:((desc\:"Sort versions in descending order (latest to earliest)"
asc\:"Sort versions in ascending order (earliest to latest)"))' \
'--node-dist-mirror=[<https\://nodejs.org/dist/> mirror]:NODE_DIST_MIRROR: ' \
'--fnm-dir=[The root directory of fnm installations]:BASE_DIR:_files' \
'--log-level=[The log level of fnm commands]:LOG_LEVEL:(quiet error info)' \
'--arch=[Override the architecture of the installed Node binary. Defaults to arch of fnm binary]:ARCH: ' \
'--version-file-strategy=[A strategy for how to resolve the Node version. Used whenever \`fnm use\` or \`fnm install\` is called without a version, or when \`--use-on-cd\` is configured on evaluation]:VERSION_FILE_STRATEGY:((local\:"Use the local version of Node defined within the current directory"
recursive\:"Use the version of Node defined within the current directory and all parent directories"))' \
'--resolve-engines=[Resolve \`engines.node\` field in \`package.json\` whenever a \`.node-version\` or \`.nvmrc\` file is not present. This feature is enabled by default. To disable it, provide \`--resolve-engines=false\`.]' \
'--latest[Only show the latest matching version]' \
'--corepack-enabled[Enable corepack support for each new installation. This will make fnm call \`corepack enable\` on every Node.js installation. For more information about corepack see <https\://nodejs.org/api/corepack.html>]' \
'-h[Print help (see more with '\''--help'\'')]' \
'--help[Print help (see more with '\''--help'\'')]' \
&& ret=0
;;
(ls-remote)
_arguments "${_arguments_options[@]}" : \
'--filter=[Filter versions by a user-defined version or a semver range]:FILTER: ' \
'--lts=[Show only LTS versions (optionally filter by LTS codename)]' \
'--sort=[Version sorting order]:SORT:((desc\:"Sort versions in descending order (latest to earliest)"
asc\:"Sort versions in ascending order (earliest to latest)"))' \
'--node-dist-mirror=[<https\://nodejs.org/dist/> mirror]:NODE_DIST_MIRROR: ' \
'--fnm-dir=[The root directory of fnm installations]:BASE_DIR:_files' \
'--log-level=[The log level of fnm commands]:LOG_LEVEL:(quiet error info)' \
'--arch=[Override the architecture of the installed Node binary. Defaults to arch of fnm binary]:ARCH: ' \
'--version-file-strategy=[A strategy for how to resolve the Node version. Used whenever \`fnm use\` or \`fnm install\` is called without a version, or when \`--use-on-cd\` is configured on evaluation]:VERSION_FILE_STRATEGY:((local\:"Use the local version of Node defined within the current directory"
recursive\:"Use the version of Node defined within the current directory and all parent directories"))' \
'--resolve-engines=[Resolve \`engines.node\` field in \`package.json\` whenever a \`.node-version\` or \`.nvmrc\` file is not present. This feature is enabled by default. To disable it, provide \`--resolve-engines=false\`.]' \
'--latest[Only show the latest matching version]' \
'--corepack-enabled[Enable corepack support for each new installation. This will make fnm call \`corepack enable\` on every Node.js installation. For more information about corepack see <https\://nodejs.org/api/corepack.html>]' \
'-h[Print help (see more with '\''--help'\'')]' \
'--help[Print help (see more with '\''--help'\'')]' \
&& ret=0
;;
(list)
_arguments "${_arguments_options[@]}" : \
'--node-dist-mirror=[<https\://nodejs.org/dist/> mirror]:NODE_DIST_MIRROR: ' \
'--fnm-dir=[The root directory of fnm installations]:BASE_DIR:_files' \
'--log-level=[The log level of fnm commands]:LOG_LEVEL:(quiet error info)' \
'--arch=[Override the architecture of the installed Node binary. Defaults to arch of fnm binary]:ARCH: ' \
'--version-file-strategy=[A strategy for how to resolve the Node version. Used whenever \`fnm use\` or \`fnm install\` is called without a version, or when \`--use-on-cd\` is configured on evaluation]:VERSION_FILE_STRATEGY:((local\:"Use the local version of Node defined within the current directory"
recursive\:"Use the version of Node defined within the current directory and all parent directories"))' \
'--resolve-engines=[Resolve \`engines.node\` field in \`package.json\` whenever a \`.node-version\` or \`.nvmrc\` file is not present. This feature is enabled by default. To disable it, provide \`--resolve-engines=false\`.]' \
'--corepack-enabled[Enable corepack support for each new installation. This will make fnm call \`corepack enable\` on every Node.js installation. For more information about corepack see <https\://nodejs.org/api/corepack.html>]' \
'-h[Print help (see more with '\''--help'\'')]' \
'--help[Print help (see more with '\''--help'\'')]' \
&& ret=0
;;
(ls)
_arguments "${_arguments_options[@]}" : \
'--node-dist-mirror=[<https\://nodejs.org/dist/> mirror]:NODE_DIST_MIRROR: ' \
'--fnm-dir=[The root directory of fnm installations]:BASE_DIR:_files' \
'--log-level=[The log level of fnm commands]:LOG_LEVEL:(quiet error info)' \
'--arch=[Override the architecture of the installed Node binary. Defaults to arch of fnm binary]:ARCH: ' \
'--version-file-strategy=[A strategy for how to resolve the Node version. Used whenever \`fnm use\` or \`fnm install\` is called without a version, or when \`--use-on-cd\` is configured on evaluation]:VERSION_FILE_STRATEGY:((local\:"Use the local version of Node defined within the current directory"
recursive\:"Use the version of Node defined within the current directory and all parent directories"))' \
'--resolve-engines=[Resolve \`engines.node\` field in \`package.json\` whenever a \`.node-version\` or \`.nvmrc\` file is not present. This feature is enabled by default. To disable it, provide \`--resolve-engines=false\`.]' \
'--corepack-enabled[Enable corepack support for each new installation. This will make fnm call \`corepack enable\` on every Node.js installation. For more information about corepack see <https\://nodejs.org/api/corepack.html>]' \
'-h[Print help (see more with '\''--help'\'')]' \
'--help[Print help (see more with '\''--help'\'')]' \
&& ret=0
;;
(install)
_arguments "${_arguments_options[@]}" : \
'--progress=[Show an interactive progress bar for the download status]:PROGRESS:(auto never always)' \
'--node-dist-mirror=[<https\://nodejs.org/dist/> mirror]:NODE_DIST_MIRROR: ' \
'--fnm-dir=[The root directory of fnm installations]:BASE_DIR:_files' \
'--log-level=[The log level of fnm commands]:LOG_LEVEL:(quiet error info)' \
'--arch=[Override the architecture of the installed Node binary. Defaults to arch of fnm binary]:ARCH: ' \
'--version-file-strategy=[A strategy for how to resolve the Node version. Used whenever \`fnm use\` or \`fnm install\` is called without a version, or when \`--use-on-cd\` is configured on evaluation]:VERSION_FILE_STRATEGY:((local\:"Use the local version of Node defined within the current directory"
recursive\:"Use the version of Node defined within the current directory and all parent directories"))' \
'--resolve-engines=[Resolve \`engines.node\` field in \`package.json\` whenever a \`.node-version\` or \`.nvmrc\` file is not present. This feature is enabled by default. To disable it, provide \`--resolve-engines=false\`.]' \
'(--latest)--lts[Install latest LTS]' \
'(--lts)--latest[Install latest version]' \
'--corepack-enabled[Enable corepack support for each new installation. This will make fnm call \`corepack enable\` on every Node.js installation. For more information about corepack see <https\://nodejs.org/api/corepack.html>]' \
'-h[Print help (see more with '\''--help'\'')]' \
'--help[Print help (see more with '\''--help'\'')]' \
'::version -- A version string. Can be a partial semver or a LTS version name by the format lts/NAME:' \
&& ret=0
;;
(i)
_arguments "${_arguments_options[@]}" : \
'--progress=[Show an interactive progress bar for the download status]:PROGRESS:(auto never always)' \
'--node-dist-mirror=[<https\://nodejs.org/dist/> mirror]:NODE_DIST_MIRROR: ' \
'--fnm-dir=[The root directory of fnm installations]:BASE_DIR:_files' \
'--log-level=[The log level of fnm commands]:LOG_LEVEL:(quiet error info)' \
'--arch=[Override the architecture of the installed Node binary. Defaults to arch of fnm binary]:ARCH: ' \
'--version-file-strategy=[A strategy for how to resolve the Node version. Used whenever \`fnm use\` or \`fnm install\` is called without a version, or when \`--use-on-cd\` is configured on evaluation]:VERSION_FILE_STRATEGY:((local\:"Use the local version of Node defined within the current directory"
recursive\:"Use the version of Node defined within the current directory and all parent directories"))' \
'--resolve-engines=[Resolve \`engines.node\` field in \`package.json\` whenever a \`.node-version\` or \`.nvmrc\` file is not present. This feature is enabled by default. To disable it, provide \`--resolve-engines=false\`.]' \
'(--latest)--lts[Install latest LTS]' \
'(--lts)--latest[Install latest version]' \
'--corepack-enabled[Enable corepack support for each new installation. This will make fnm call \`corepack enable\` on every Node.js installation. For more information about corepack see <https\://nodejs.org/api/corepack.html>]' \
'-h[Print help (see more with '\''--help'\'')]' \
'--help[Print help (see more with '\''--help'\'')]' \
'::version -- A version string. Can be a partial semver or a LTS version name by the format lts/NAME:' \
&& ret=0
;;
(use)
_arguments "${_arguments_options[@]}" : \
'--node-dist-mirror=[<https\://nodejs.org/dist/> mirror]:NODE_DIST_MIRROR: ' \
'--fnm-dir=[The root directory of fnm installations]:BASE_DIR:_files' \
'--log-level=[The log level of fnm commands]:LOG_LEVEL:(quiet error info)' \
'--arch=[Override the architecture of the installed Node binary. Defaults to arch of fnm binary]:ARCH: ' \
'--version-file-strategy=[A strategy for how to resolve the Node version. Used whenever \`fnm use\` or \`fnm install\` is called without a version, or when \`--use-on-cd\` is configured on evaluation]:VERSION_FILE_STRATEGY:((local\:"Use the local version of Node defined within the current directory"
recursive\:"Use the version of Node defined within the current directory and all parent directories"))' \
'--resolve-engines=[Resolve \`engines.node\` field in \`package.json\` whenever a \`.node-version\` or \`.nvmrc\` file is not present. This feature is enabled by default. To disable it, provide \`--resolve-engines=false\`.]' \
'--install-if-missing[Install the version if it isn'\''t installed yet]' \
'--silent-if-unchanged[Don'\''t output a message identifying the version being used if it will not change due to execution of this command]' \
'--corepack-enabled[Enable corepack support for each new installation. This will make fnm call \`corepack enable\` on every Node.js installation. For more information about corepack see <https\://nodejs.org/api/corepack.html>]' \
'-h[Print help (see more with '\''--help'\'')]' \
'--help[Print help (see more with '\''--help'\'')]' \
'::version:' \
&& ret=0
;;
(env)
_arguments "${_arguments_options[@]}" : \
'--shell=[The shell syntax to use. Infers when missing]:SHELL:(bash zsh fish powershell)' \
'--node-dist-mirror=[<https\://nodejs.org/dist/> mirror]:NODE_DIST_MIRROR: ' \
'--fnm-dir=[The root directory of fnm installations]:BASE_DIR:_files' \
'--log-level=[The log level of fnm commands]:LOG_LEVEL:(quiet error info)' \
'--arch=[Override the architecture of the installed Node binary. Defaults to arch of fnm binary]:ARCH: ' \
'--version-file-strategy=[A strategy for how to resolve the Node version. Used whenever \`fnm use\` or \`fnm install\` is called without a version, or when \`--use-on-cd\` is configured on evaluation]:VERSION_FILE_STRATEGY:((local\:"Use the local version of Node defined within the current directory"
recursive\:"Use the version of Node defined within the current directory and all parent directories"))' \
'--resolve-engines=[Resolve \`engines.node\` field in \`package.json\` whenever a \`.node-version\` or \`.nvmrc\` file is not present. This feature is enabled by default. To disable it, provide \`--resolve-engines=false\`.]' \
'(--shell)--json[Print JSON instead of shell commands]' \
'--multi[Deprecated. This is the default now]' \
'--use-on-cd[Print the script to change Node versions every directory change]' \
'--corepack-enabled[Enable corepack support for each new installation. This will make fnm call \`corepack enable\` on every Node.js installation. For more information about corepack see <https\://nodejs.org/api/corepack.html>]' \
'-h[Print help (see more with '\''--help'\'')]' \
'--help[Print help (see more with '\''--help'\'')]' \
&& ret=0
;;
(completions)
_arguments "${_arguments_options[@]}" : \
'--shell=[The shell syntax to use. Infers when missing]:SHELL:(bash zsh fish powershell)' \
'--node-dist-mirror=[<https\://nodejs.org/dist/> mirror]:NODE_DIST_MIRROR: ' \
'--fnm-dir=[The root directory of fnm installations]:BASE_DIR:_files' \
'--log-level=[The log level of fnm commands]:LOG_LEVEL:(quiet error info)' \
'--arch=[Override the architecture of the installed Node binary. Defaults to arch of fnm binary]:ARCH: ' \
'--version-file-strategy=[A strategy for how to resolve the Node version. Used whenever \`fnm use\` or \`fnm install\` is called without a version, or when \`--use-on-cd\` is configured on evaluation]:VERSION_FILE_STRATEGY:((local\:"Use the local version of Node defined within the current directory"
recursive\:"Use the version of Node defined within the current directory and all parent directories"))' \
'--resolve-engines=[Resolve \`engines.node\` field in \`package.json\` whenever a \`.node-version\` or \`.nvmrc\` file is not present. This feature is enabled by default. To disable it, provide \`--resolve-engines=false\`.]' \
'--corepack-enabled[Enable corepack support for each new installation. This will make fnm call \`corepack enable\` on every Node.js installation. For more information about corepack see <https\://nodejs.org/api/corepack.html>]' \
'-h[Print help (see more with '\''--help'\'')]' \
'--help[Print help (see more with '\''--help'\'')]' \
&& ret=0
;;
(alias)
_arguments "${_arguments_options[@]}" : \
'--node-dist-mirror=[<https\://nodejs.org/dist/> mirror]:NODE_DIST_MIRROR: ' \
'--fnm-dir=[The root directory of fnm installations]:BASE_DIR:_files' \
'--log-level=[The log level of fnm commands]:LOG_LEVEL:(quiet error info)' \
'--arch=[Override the architecture of the installed Node binary. Defaults to arch of fnm binary]:ARCH: ' \
'--version-file-strategy=[A strategy for how to resolve the Node version. Used whenever \`fnm use\` or \`fnm install\` is called without a version, or when \`--use-on-cd\` is configured on evaluation]:VERSION_FILE_STRATEGY:((local\:"Use the local version of Node defined within the current directory"
recursive\:"Use the version of Node defined within the current directory and all parent directories"))' \
'--resolve-engines=[Resolve \`engines.node\` field in \`package.json\` whenever a \`.node-version\` or \`.nvmrc\` file is not present. This feature is enabled by default. To disable it, provide \`--resolve-engines=false\`.]' \
'--corepack-enabled[Enable corepack support for each new installation. This will make fnm call \`corepack enable\` on every Node.js installation. For more information about corepack see <https\://nodejs.org/api/corepack.html>]' \
'-h[Print help (see more with '\''--help'\'')]' \
'--help[Print help (see more with '\''--help'\'')]' \
':to_version:' \
':name:' \
&& ret=0
;;
(unalias)
_arguments "${_arguments_options[@]}" : \
'--node-dist-mirror=[<https\://nodejs.org/dist/> mirror]:NODE_DIST_MIRROR: ' \
'--fnm-dir=[The root directory of fnm installations]:BASE_DIR:_files' \
'--log-level=[The log level of fnm commands]:LOG_LEVEL:(quiet error info)' \
'--arch=[Override the architecture of the installed Node binary. Defaults to arch of fnm binary]:ARCH: ' \
'--version-file-strategy=[A strategy for how to resolve the Node version. Used whenever \`fnm use\` or \`fnm install\` is called without a version, or when \`--use-on-cd\` is configured on evaluation]:VERSION_FILE_STRATEGY:((local\:"Use the local version of Node defined within the current directory"
recursive\:"Use the version of Node defined within the current directory and all parent directories"))' \
'--resolve-engines=[Resolve \`engines.node\` field in \`package.json\` whenever a \`.node-version\` or \`.nvmrc\` file is not present. This feature is enabled by default. To disable it, provide \`--resolve-engines=false\`.]' \
'--corepack-enabled[Enable corepack support for each new installation. This will make fnm call \`corepack enable\` on every Node.js installation. For more information about corepack see <https\://nodejs.org/api/corepack.html>]' \
'-h[Print help (see more with '\''--help'\'')]' \
'--help[Print help (see more with '\''--help'\'')]' \
':requested_alias:' \
&& ret=0
;;
(default)
_arguments "${_arguments_options[@]}" : \
'--node-dist-mirror=[<https\://nodejs.org/dist/> mirror]:NODE_DIST_MIRROR: ' \
'--fnm-dir=[The root directory of fnm installations]:BASE_DIR:_files' \
'--log-level=[The log level of fnm commands]:LOG_LEVEL:(quiet error info)' \
'--arch=[Override the architecture of the installed Node binary. Defaults to arch of fnm binary]:ARCH: ' \
'--version-file-strategy=[A strategy for how to resolve the Node version. Used whenever \`fnm use\` or \`fnm install\` is called without a version, or when \`--use-on-cd\` is configured on evaluation]:VERSION_FILE_STRATEGY:((local\:"Use the local version of Node defined within the current directory"
recursive\:"Use the version of Node defined within the current directory and all parent directories"))' \
'--resolve-engines=[Resolve \`engines.node\` field in \`package.json\` whenever a \`.node-version\` or \`.nvmrc\` file is not present. This feature is enabled by default. To disable it, provide \`--resolve-engines=false\`.]' \
'--corepack-enabled[Enable corepack support for each new installation. This will make fnm call \`corepack enable\` on every Node.js installation. For more information about corepack see <https\://nodejs.org/api/corepack.html>]' \
'-h[Print help (see more with '\''--help'\'')]' \
'--help[Print help (see more with '\''--help'\'')]' \
':version:' \
&& ret=0
;;
(current)
_arguments "${_arguments_options[@]}" : \
'--node-dist-mirror=[<https\://nodejs.org/dist/> mirror]:NODE_DIST_MIRROR: ' \
'--fnm-dir=[The root directory of fnm installations]:BASE_DIR:_files' \
'--log-level=[The log level of fnm commands]:LOG_LEVEL:(quiet error info)' \
'--arch=[Override the architecture of the installed Node binary. Defaults to arch of fnm binary]:ARCH: ' \
'--version-file-strategy=[A strategy for how to resolve the Node version. Used whenever \`fnm use\` or \`fnm install\` is called without a version, or when \`--use-on-cd\` is configured on evaluation]:VERSION_FILE_STRATEGY:((local\:"Use the local version of Node defined within the current directory"
recursive\:"Use the version of Node defined within the current directory and all parent directories"))' \
'--resolve-engines=[Resolve \`engines.node\` field in \`package.json\` whenever a \`.node-version\` or \`.nvmrc\` file is not present. This feature is enabled by default. To disable it, provide \`--resolve-engines=false\`.]' \
'--corepack-enabled[Enable corepack support for each new installation. This will make fnm call \`corepack enable\` on every Node.js installation. For more information about corepack see <https\://nodejs.org/api/corepack.html>]' \
'-h[Print help (see more with '\''--help'\'')]' \
'--help[Print help (see more with '\''--help'\'')]' \
&& ret=0
;;
(exec)
_arguments "${_arguments_options[@]}" : \
'--using=[Either an explicit version, or a filename with the version written in it]:VERSION: ' \
'--node-dist-mirror=[<https\://nodejs.org/dist/> mirror]:NODE_DIST_MIRROR: ' \
'--fnm-dir=[The root directory of fnm installations]:BASE_DIR:_files' \
'--log-level=[The log level of fnm commands]:LOG_LEVEL:(quiet error info)' \
'--arch=[Override the architecture of the installed Node binary. Defaults to arch of fnm binary]:ARCH: ' \
'--version-file-strategy=[A strategy for how to resolve the Node version. Used whenever \`fnm use\` or \`fnm install\` is called without a version, or when \`--use-on-cd\` is configured on evaluation]:VERSION_FILE_STRATEGY:((local\:"Use the local version of Node defined within the current directory"
recursive\:"Use the version of Node defined within the current directory and all parent directories"))' \
'--resolve-engines=[Resolve \`engines.node\` field in \`package.json\` whenever a \`.node-version\` or \`.nvmrc\` file is not present. This feature is enabled by default. To disable it, provide \`--resolve-engines=false\`.]' \
'--using-file[Deprecated. This is the default now]' \
'--corepack-enabled[Enable corepack support for each new installation. This will make fnm call \`corepack enable\` on every Node.js installation. For more information about corepack see <https\://nodejs.org/api/corepack.html>]' \
'-h[Print help (see more with '\''--help'\'')]' \
'--help[Print help (see more with '\''--help'\'')]' \
'*::arguments -- The command to run:' \
&& ret=0
;;
(uninstall)
_arguments "${_arguments_options[@]}" : \
'--node-dist-mirror=[<https\://nodejs.org/dist/> mirror]:NODE_DIST_MIRROR: ' \
'--fnm-dir=[The root directory of fnm installations]:BASE_DIR:_files' \
'--log-level=[The log level of fnm commands]:LOG_LEVEL:(quiet error info)' \
'--arch=[Override the architecture of the installed Node binary. Defaults to arch of fnm binary]:ARCH: ' \
'--version-file-strategy=[A strategy for how to resolve the Node version. Used whenever \`fnm use\` or \`fnm install\` is called without a version, or when \`--use-on-cd\` is configured on evaluation]:VERSION_FILE_STRATEGY:((local\:"Use the local version of Node defined within the current directory"
recursive\:"Use the version of Node defined within the current directory and all parent directories"))' \
'--resolve-engines=[Resolve \`engines.node\` field in \`package.json\` whenever a \`.node-version\` or \`.nvmrc\` file is not present. This feature is enabled by default. To disable it, provide \`--resolve-engines=false\`.]' \
'--corepack-enabled[Enable corepack support for each new installation. This will make fnm call \`corepack enable\` on every Node.js installation. For more information about corepack see <https\://nodejs.org/api/corepack.html>]' \
'-h[Print help (see more with '\''--help'\'')]' \
'--help[Print help (see more with '\''--help'\'')]' \
'::version:' \
&& ret=0
;;
(uni)
_arguments "${_arguments_options[@]}" : \
'--node-dist-mirror=[<https\://nodejs.org/dist/> mirror]:NODE_DIST_MIRROR: ' \
'--fnm-dir=[The root directory of fnm installations]:BASE_DIR:_files' \
'--log-level=[The log level of fnm commands]:LOG_LEVEL:(quiet error info)' \
'--arch=[Override the architecture of the installed Node binary. Defaults to arch of fnm binary]:ARCH: ' \
'--version-file-strategy=[A strategy for how to resolve the Node version. Used whenever \`fnm use\` or \`fnm install\` is called without a version, or when \`--use-on-cd\` is configured on evaluation]:VERSION_FILE_STRATEGY:((local\:"Use the local version of Node defined within the current directory"
recursive\:"Use the version of Node defined within the current directory and all parent directories"))' \
'--resolve-engines=[Resolve \`engines.node\` field in \`package.json\` whenever a \`.node-version\` or \`.nvmrc\` file is not present. This feature is enabled by default. To disable it, provide \`--resolve-engines=false\`.]' \
'--corepack-enabled[Enable corepack support for each new installation. This will make fnm call \`corepack enable\` on every Node.js installation. For more information about corepack see <https\://nodejs.org/api/corepack.html>]' \
'-h[Print help (see more with '\''--help'\'')]' \
'--help[Print help (see more with '\''--help'\'')]' \
'::version:' \
&& ret=0
;;
(help)
_arguments "${_arguments_options[@]}" : \
":: :_fnm__help_commands" \
"*::: :->help" \
&& ret=0

    case $state in
    (help)
        words=($line[1] "${words[@]}")
        (( CURRENT += 1 ))
        curcontext="${curcontext%:*:*}:fnm-help-command-$line[1]:"
        case $line[1] in
            (list-remote)
_arguments "${_arguments_options[@]}" : \
&& ret=0
;;
(list)
_arguments "${_arguments_options[@]}" : \
&& ret=0
;;
(install)
_arguments "${_arguments_options[@]}" : \
&& ret=0
;;
(use)
_arguments "${_arguments_options[@]}" : \
&& ret=0
;;
(env)
_arguments "${_arguments_options[@]}" : \
&& ret=0
;;
(completions)
_arguments "${_arguments_options[@]}" : \
&& ret=0
;;
(alias)
_arguments "${_arguments_options[@]}" : \
&& ret=0
;;
(unalias)
_arguments "${_arguments_options[@]}" : \
&& ret=0
;;
(default)
_arguments "${_arguments_options[@]}" : \
&& ret=0
;;
(current)
_arguments "${_arguments_options[@]}" : \
&& ret=0
;;
(exec)
_arguments "${_arguments_options[@]}" : \
&& ret=0
;;
(uninstall)
_arguments "${_arguments_options[@]}" : \
&& ret=0
;;
(help)
_arguments "${_arguments_options[@]}" : \
&& ret=0
;;
        esac
    ;;
esac
;;
        esac
    ;;
esac
}

(( $+functions[_fnm_commands] )) ||
_fnm_commands() {
    local commands; commands=(
'list-remote:List all remote Node.js versions' \
'ls-remote:List all remote Node.js versions' \
'list:List all locally installed Node.js versions' \
'ls:List all locally installed Node.js versions' \
'install:Install a new Node.js version' \
'i:Install a new Node.js version' \
'use:Change Node.js version' \
'env:Print and set up required environment variables for fnm' \
'completions:Print shell completions to stdout' \
'alias:Alias a version to a common name' \
'unalias:Remove an alias definition' \
'default:Set a version as the default version' \
'current:Print the current Node.js version' \
'exec:Run a command within fnm context' \
'uninstall:Uninstall a Node.js version' \
'uni:Uninstall a Node.js version' \
'help:Print this message or the help of the given subcommand(s)' \
    )
    _describe -t commands 'fnm commands' commands "$@"
}
(( $+functions[_alias_commands] )) ||
_alias_commands() {
    local commands; commands=()
    _describe -t commands 'alias commands' commands "$@"
}
(( $+functions[_completions_commands] )) ||
_completions_commands() {
    local commands; commands=()
    _describe -t commands 'completions commands' commands "$@"
}
(( $+functions[_current_commands] )) ||
_current_commands() {
    local commands; commands=()
    _describe -t commands 'current commands' commands "$@"
}
(( $+functions[_default_commands] )) ||
_default_commands() {
    local commands; commands=()
    _describe -t commands 'default commands' commands "$@"
}
(( $+functions[_env_commands] )) ||
_env_commands() {
    local commands; commands=()
    _describe -t commands 'env commands' commands "$@"
}
(( $+functions[_exec_commands] )) ||
_exec_commands() {
    local commands; commands=()
    _describe -t commands 'exec commands' commands "$@"
}
(( $+functions[_fnm__help_commands] )) ||
_fnm__help_commands() {
    local commands; commands=(
'list-remote:List all remote Node.js versions' \
'list:List all locally installed Node.js versions' \
'install:Install a new Node.js version' \
'use:Change Node.js version' \
'env:Print and set up required environment variables for fnm' \
'completions:Print shell completions to stdout' \
'alias:Alias a version to a common name' \
'unalias:Remove an alias definition' \
'default:Set a version as the default version' \
'current:Print the current Node.js version' \
'exec:Run a command within fnm context' \
'uninstall:Uninstall a Node.js version' \
'help:Print this message or the help of the given subcommand(s)' \
    )
    _describe -t commands 'fnm help commands' commands "$@"
}
(( $+functions[_fnm__help__alias_commands] )) ||
_fnm__help__alias_commands() {
    local commands; commands=()
    _describe -t commands 'fnm help alias commands' commands "$@"
}
(( $+functions[_fnm__help__completions_commands] )) ||
_fnm__help__completions_commands() {
    local commands; commands=()
    _describe -t commands 'fnm help completions commands' commands "$@"
}
(( $+functions[_fnm__help__current_commands] )) ||
_fnm__help__current_commands() {
    local commands; commands=()
    _describe -t commands 'fnm help current commands' commands "$@"
}
(( $+functions[_fnm__help__default_commands] )) ||
_fnm__help__default_commands() {
    local commands; commands=()
    _describe -t commands 'fnm help default commands' commands "$@"
}
(( $+functions[_fnm__help__env_commands] )) ||
_fnm__help__env_commands() {
    local commands; commands=()
    _describe -t commands 'fnm help env commands' commands "$@"
}
(( $+functions[_fnm__help__exec_commands] )) ||
_fnm__help__exec_commands() {
    local commands; commands=()
    _describe -t commands 'fnm help exec commands' commands "$@"
}
(( $+functions[_fnm__help__help_commands] )) ||
_fnm__help__help_commands() {
    local commands; commands=()
    _describe -t commands 'fnm help help commands' commands "$@"
}
(( $+functions[_fnm__help__install_commands] )) ||
_fnm__help__install_commands() {
    local commands; commands=()
    _describe -t commands 'fnm help install commands' commands "$@"
}
(( $+functions[_fnm__help__list_commands] )) ||
_fnm__help__list_commands() {
    local commands; commands=()
    _describe -t commands 'fnm help list commands' commands "$@"
}
(( $+functions[_fnm__help__list-remote_commands] )) ||
_fnm__help__list-remote_commands() {
    local commands; commands=()
    _describe -t commands 'fnm help list-remote commands' commands "$@"
}
(( $+functions[_fnm__help__unalias_commands] )) ||
_fnm__help__unalias_commands() {
    local commands; commands=()
    _describe -t commands 'fnm help unalias commands' commands "$@"
}
(( $+functions[_fnm__help__uninstall_commands] )) ||
_fnm__help__uninstall_commands() {
    local commands; commands=()
    _describe -t commands 'fnm help uninstall commands' commands "$@"
}
(( $+functions[_fnm__help__use_commands] )) ||
_fnm__help__use_commands() {
    local commands; commands=()
    _describe -t commands 'fnm help use commands' commands "$@"
}
(( $+functions[_install_commands] )) ||
_install_commands() {
    local commands; commands=()
    _describe -t commands 'install commands' commands "$@"
}
(( $+functions[_list_commands] )) ||
_list_commands() {
    local commands; commands=()
    _describe -t commands 'list commands' commands "$@"
}
(( $+functions[_list-remote_commands] )) ||
_list-remote_commands() {
    local commands; commands=()
    _describe -t commands 'list-remote commands' commands "$@"
}
(( $+functions[_unalias_commands] )) ||
_unalias_commands() {
    local commands; commands=()
    _describe -t commands 'unalias commands' commands "$@"
}
(( $+functions[_uninstall_commands] )) ||
_uninstall_commands() {
    local commands; commands=()
    _describe -t commands 'uninstall commands' commands "$@"
}
(( $+functions[_use_commands] )) ||
_use_commands() {
    local commands; commands=()
    _describe -t commands 'use commands' commands "$@"
}

if [ "$funcstack[1]" = "_fnm" ]; then
    _fnm "$@"
else
    compdef _fnm fnm
fi
