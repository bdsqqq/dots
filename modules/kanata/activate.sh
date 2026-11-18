#!/bin/bash
set -euo pipefail

source_binary=$1
source_iconv=$2
source_charset=$3
label=$4
virtualhid_daemon=$5
destination=$6
lib_dir=$7

for target in "$destination" "$lib_dir/libiconv.2.dylib" "$lib_dir/libcharset.1.dylib"; do
  if [ -d "$target" ]; then
    echo "refusing to replace directory target: $target" >&2
    exit 1
  fi
done

if [ ! -x "$virtualhid_daemon" ]; then
  echo "warning: Karabiner VirtualHIDDevice daemon missing; install/activate it manually before starting kanata" >&2
fi

# TCC needs real files at stable paths. Stage, relocate, and sign before replacing
# them; leave identical files alone so activation does not churn their identity.
mkdir -p "$(dirname "$destination")" "$lib_dir"
stage="$(mktemp -d "$(dirname "$(dirname "$destination")")/.kanata-stage.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/bin" "$stage/lib"

install -m 0755 "$source_binary" "$stage/bin/kanata"
install -m 0644 "$source_iconv" "$stage/lib/libiconv.2.dylib"
install -m 0644 "$source_charset" "$stage/lib/libcharset.1.dylib"

/usr/bin/install_name_tool \
  -change "$source_iconv" @executable_path/../lib/kanata/libiconv.2.dylib \
  "$stage/bin/kanata"
/usr/bin/install_name_tool \
  -id @loader_path/libcharset.1.dylib \
  "$stage/lib/libcharset.1.dylib"
/usr/bin/install_name_tool \
  -id @loader_path/libiconv.2.dylib \
  -change "$source_charset" @loader_path/libcharset.1.dylib \
  "$stage/lib/libiconv.2.dylib"

/usr/bin/codesign --force --sign - "$stage/lib/libcharset.1.dylib"
/usr/bin/codesign --force --sign - "$stage/lib/libiconv.2.dylib"
/usr/bin/codesign --force --sign - --identifier "$label" "$stage/bin/kanata"

if [ ! -x "$destination" ] \
  || [ ! -f "$lib_dir/libiconv.2.dylib" ] \
  || [ ! -f "$lib_dir/libcharset.1.dylib" ] \
  || ! cmp -s "$stage/bin/kanata" "$destination" \
  || ! cmp -s "$stage/lib/libiconv.2.dylib" "$lib_dir/libiconv.2.dylib" \
  || ! cmp -s "$stage/lib/libcharset.1.dylib" "$lib_dir/libcharset.1.dylib"; then
  mv -f "$stage/lib/libcharset.1.dylib" "$lib_dir/libcharset.1.dylib"
  mv -f "$stage/lib/libiconv.2.dylib" "$lib_dir/libiconv.2.dylib"
  mv -f "$stage/bin/kanata" "$destination"
fi

[ -f "$destination" ] && [ -x "$destination" ]
[ -f "$lib_dir/libiconv.2.dylib" ] && [ -f "$lib_dir/libcharset.1.dylib" ]
"$destination" --version >/dev/null
