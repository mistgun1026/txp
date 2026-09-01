#!/bin/sh
# Pulls the latest main from GitHub and repackages it as app.tar.gz with
# package.json at the archive root, ready for Hostinger's Node.js build.
set -e
D=/home/u950169649/domains/txp.densetsuph.com
cd $D/public_html
curl -sfLo s.tgz https://codeload.github.com/mistgun1026/txp/tar.gz/refs/heads/main
rm -rf x
mkdir x
tar -xzf s.tgz -C x --strip-components=1
tar -czf app.tar.gz -C x .
rm -rf x s.tgz
{ date; ls -l app.tar.gz; echo FETCH_OK; } > fetch-ok.txt 2>&1
