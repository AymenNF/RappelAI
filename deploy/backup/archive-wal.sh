#!/bin/sh
set -eu
umask 077
source_file=$1
wal_name=$2
case "$wal_name" in ''|*[!A-Za-z0-9.]*) exit 1 ;; esac
destination="/wal-archive/$wal_name"
# Retrying an identical segment is safe; never overwrite a different WAL file.
if [ -f "$destination" ]; then cmp -s "$source_file" "$destination"; exit $?; fi
temporary="$destination.part"
cp "$source_file" "$temporary"
sync -f "$temporary"
ln "$temporary" "$destination"
rm "$temporary"
sync -f /wal-archive
