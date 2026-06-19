#!/usr/bin/env bash
set -euo pipefail

npm run backup
git pull origin main
npm install

if npm run | grep -qE '^[[:space:]]*migrate$'; then
  npm run migrate
fi

pm2 restart all
pm2 save
