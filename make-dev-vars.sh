#!/bin/zsh
# Writes .dev.vars (gitignored) from the macOS Keychain for `wrangler dev`.
set -e
cd "$(dirname "$0")"
cat > .dev.vars <<EOF
SHOPIFY_CLIENT_ID=$(security find-generic-password -s "SHOPIFY_CLIENT_ID_dev_access_nuway" -w)
SHOPIFY_CLIENT_SECRET=$(security find-generic-password -s "SHOPIFY_CLIENT_SECRET_dev_access_nuway" -w)
AIRCALL_API_ID=$(security find-generic-password -s "aircall-api-id" -a "drone-deer-recovery" -w)
AIRCALL_API_TOKEN=$(security find-generic-password -s "aircall-api-token" -a "drone-deer-recovery" -w)
FINALE_API_KEY=$(security find-generic-password -s "finale-api-key" -w)
FINALE_API_SECRET=$(security find-generic-password -s "finale-api-secret" -w)
EOF
chmod 600 .dev.vars
echo "wrote .dev.vars"
