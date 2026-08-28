R=https://raw.githubusercontent.com/mistgun1026/txp/main
D=/home/u950169649/domains/txp.densetsuph.com
S=$D/deploy-src
rm -rf $S
mkdir -p $S/src
set -e
curl -sfL "$R/package.json?token=AO7V2MLO4U337N6T5DCIYITKSFIP3AA" -o $S/package.json
curl -sfL "$R/server.js?token=AO7V2MIBGWATGOFK23RYDXLKSFIP3AA" -o $S/server.js
curl -sfL "$R/src/store.js?token=AO7V2MKG4PFEVVVV4GN4IJTKSFIP3AA" -o $S/src/store.js
curl -sfL "$R/src/xero.js?token=AO7V2MPM4PYCBKJFVWX6QCLKSFIP3AA" -o $S/src/xero.js
curl -sfL "$R/src/tools.js?token=AO7V2MLZC4P6KDR3ROWO7Z3KSFIP5AA" -o $S/src/tools.js
curl -sfL "$R/src/mcp.js?token=AO7V2MPPB74QNJ66LE73MXTKSFIP5AA" -o $S/src/mcp.js
curl -sfL "$R/src/dashboard.js?token=AO7V2MOJJMTGGSUBZEJE3TDKSFIP5AA" -o $S/src/dashboard.js
tar -czf $D/public_html/app.tar.gz -C $S .
wc -c $S/package.json $S/server.js $S/src/store.js $S/src/xero.js $S/src/tools.js $S/src/mcp.js $S/src/dashboard.js > $D/public_html/fetch-ok.txt
echo FETCH_OK >> $D/public_html/fetch-ok.txt
