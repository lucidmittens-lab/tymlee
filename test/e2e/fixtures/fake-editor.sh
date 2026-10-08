#!/bin/sh
# A stand-in for $EDITOR: rename "mtg standup" to "mtg planning".
sed -i 's/mtg standup/mtg planning/' "$1"
