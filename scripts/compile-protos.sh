#!/usr/bin/env sh
for protoFile in src/protos/*.proto; do
  protoName=${protoFile%.*}
  jsPath="$protoName.js"
  yarn pbjs -t static-module -w commonjs -o "$jsPath" "$protoFile"
  yarn pbts -o "$protoName.d.ts" "$jsPath"
done
