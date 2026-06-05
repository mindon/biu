#!/usr/bin/env bash
# biu installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/mindon/biu/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/mindon/biu/main/install.sh | bash -s -- v1.1.9
#
# Environment overrides:
#   BIU_INSTALL   Install root (default: $HOME/.biu)
#   GITHUB        GitHub origin (default: https://github.com)

set -euo pipefail

platform=$(uname -ms)

if [[ ${OS:-} = Windows_NT ]]; then
    if [[ $platform != MINGW64* ]]; then
        powershell -c "irm https://raw.githubusercontent.com/mindon/biu/main/install.ps1|iex"
        exit $?
    fi
fi

# --- colors ---
Color_Off=''
Red=''
Green=''
Dim=''
Bold_White=''
Bold_Green=''

if [[ -t 1 ]]; then
    Color_Off='\033[0m'
    Red='\033[0;31m'
    Green='\033[0;32m'
    Dim='\033[0;2m'
    Bold_Green='\033[1;32m'
    Bold_White='\033[1m'
fi

error() {
    echo -e "${Red}error${Color_Off}:" "$@" >&2
    exit 1
}

info() {
    echo -e "${Dim}$@ ${Color_Off}"
}

info_bold() {
    echo -e "${Bold_White}$@ ${Color_Off}"
}

success() {
    echo -e "${Green}$@ ${Color_Off}"
}

command -v curl >/dev/null ||
    error 'curl is required to install biu'
command -v unzip >/dev/null ||
    error 'unzip is required to install biu'

if [[ $# -gt 1 ]]; then
    error 'Too many arguments. Only one optional version tag is allowed (e.g. "v1.1.9").'
fi

# --- detect libc (musl vs glibc) on Linux ---
detect_libc() {
    if [[ -f /lib/ld-musl-x86_64.so.1 || -f /lib/ld-musl-aarch64.so.1 ]]; then
        echo musl
        return
    fi
    if command -v ldd >/dev/null 2>&1; then
        if ldd --version 2>&1 | grep -qi musl; then
            echo musl
            return
        fi
    fi
    echo glibc
}

# --- detect target ---
case $platform in
'Darwin x86_64')
    target=darwin-x64
    ;;
'Darwin arm64')
    target=darwin-aarch64
    ;;
'Linux aarch64' | 'Linux arm64')
    if [[ $(detect_libc) = musl ]]; then
        target=linux-aarch64-musl
    else
        target=linux-aarch64
    fi
    ;;
'MINGW64'*)
    target=windows-x64
    ;;
'Linux riscv64')
    error 'biu is not supported on riscv64'
    ;;
'Linux x86_64' | *)
    if [[ $(detect_libc) = musl ]]; then
        target=linux-x64-musl
    else
        target=linux-x64
    fi
    ;;
esac

# Rosetta 2 → switch to native arm64
if [[ $target = darwin-x64 ]]; then
    if [[ $(sysctl -n sysctl.proc_translated 2>/dev/null) = 1 ]]; then
        target=darwin-aarch64
        info "Your shell is running in Rosetta 2. Downloading biu for $target instead"
    fi
fi

GITHUB=${GITHUB-"https://github.com"}
github_repo="$GITHUB/mindon/biu"

asset="biu-${target}.zip"

if [[ $# = 0 ]]; then
    biu_uri="$github_repo/releases/latest/download/$asset"
else
    biu_uri="$github_repo/releases/download/$1/$asset"
fi

# --- install paths ---
install_env=BIU_INSTALL
bin_env=\$$install_env/bin

install_dir=${BIU_INSTALL:-$HOME/.biu}
bin_dir=$install_dir/bin
exe=$bin_dir/biu

if [[ ! -d $bin_dir ]]; then
    mkdir -p "$bin_dir" ||
        error "Failed to create install directory \"$bin_dir\""
fi

# --- download & extract ---
tmpzip=$(mktemp -t biu-XXXXXX.zip 2>/dev/null || mktemp /tmp/biu-XXXXXX.zip)
trap 'rm -f "$tmpzip"' EXIT

curl --fail --location --progress-bar --output "$tmpzip" "$biu_uri" ||
    error "Failed to download biu from \"$biu_uri\""

unzip -oqd "$bin_dir" "$tmpzip" ||
    error 'Failed to extract biu'

# Drop bundled docs out of $bin (they ship inside the zip alongside the binary).
rm -f "$bin_dir/USAGE.md"

[[ -f $exe ]] ||
    error "biu binary not found in archive (expected $exe)"

chmod +x "$exe" ||
    error 'Failed to set permissions on biu executable'

tildify() {
    if [[ $1 = $HOME/* ]]; then
        local replacement=\~/
        echo "${1/$HOME\//$replacement}"
    else
        echo "$1"
    fi
}

success "biu was installed successfully to $Bold_Green$(tildify "$exe")"

if command -v biu >/dev/null; then
    echo "Run 'biu --help' to get started"
    exit
fi

refresh_command=''

tilde_bin_dir=$(tildify "$bin_dir")
quoted_install_dir=\"${install_dir//\"/\\\"}\"

if [[ $quoted_install_dir = \"$HOME/* ]]; then
    quoted_install_dir=${quoted_install_dir/$HOME\//\$HOME/}
fi

echo

case $(basename "$SHELL") in
fish)
    commands=(
        "set --export $install_env $quoted_install_dir"
        "set --export PATH $bin_env \$PATH"
    )

    fish_config=$HOME/.config/fish/config.fish
    tilde_fish_config=$(tildify "$fish_config")

    if [[ -w $fish_config ]]; then
        {
            echo -e '\n# biu'
            for command in "${commands[@]}"; do
                echo "$command"
            done
        } >>"$fish_config"

        info "Added \"$tilde_bin_dir\" to \$PATH in \"$tilde_fish_config\""
        refresh_command="source $tilde_fish_config"
    else
        echo "Manually add the directory to $tilde_fish_config (or similar):"
        for command in "${commands[@]}"; do
            info_bold "  $command"
        done
    fi
    ;;
zsh)
    commands=(
        "export $install_env=$quoted_install_dir"
        "export PATH=\"$bin_env:\$PATH\""
    )

    zsh_config=$HOME/.zshrc
    tilde_zsh_config=$(tildify "$zsh_config")

    if [[ -w $zsh_config ]]; then
        {
            echo -e '\n# biu'
            for command in "${commands[@]}"; do
                echo "$command"
            done
        } >>"$zsh_config"

        info "Added \"$tilde_bin_dir\" to \$PATH in \"$tilde_zsh_config\""
        refresh_command="exec $SHELL"
    else
        echo "Manually add the directory to $tilde_zsh_config (or similar):"
        for command in "${commands[@]}"; do
            info_bold "  $command"
        done
    fi
    ;;
bash)
    commands=(
        "export $install_env=$quoted_install_dir"
        "export PATH=\"$bin_env:\$PATH\""
    )

    bash_configs=(
        "$HOME/.bash_profile"
        "$HOME/.bashrc"
    )

    if [[ ${XDG_CONFIG_HOME:-} ]]; then
        bash_configs+=(
            "$XDG_CONFIG_HOME/.bash_profile"
            "$XDG_CONFIG_HOME/.bashrc"
            "$XDG_CONFIG_HOME/bash_profile"
            "$XDG_CONFIG_HOME/bashrc"
        )
    fi

    set_manually=true
    for bash_config in "${bash_configs[@]}"; do
        tilde_bash_config=$(tildify "$bash_config")

        if [[ -w $bash_config ]]; then
            {
                echo -e '\n# biu'
                for command in "${commands[@]}"; do
                    echo "$command"
                done
            } >>"$bash_config"

            info "Added \"$tilde_bin_dir\" to \$PATH in \"$tilde_bash_config\""
            refresh_command="source $bash_config"
            set_manually=false
            break
        fi
    done

    if [[ $set_manually = true ]]; then
        echo "Manually add the directory to ~/.bashrc (or similar):"
        for command in "${commands[@]}"; do
            info_bold "  $command"
        done
    fi
    ;;
*)
    echo 'Manually add the directory to ~/.bashrc (or similar):'
    info_bold "  export $install_env=$quoted_install_dir"
    info_bold "  export PATH=\"$bin_env:\$PATH\""
    ;;
esac

echo
info "To get started, run:"
echo

if [[ $refresh_command ]]; then
    info_bold "  $refresh_command"
fi

info_bold "  biu --help"
