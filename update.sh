#!/usr/bin/env bash
set -euo pipefail

npm run backup:all
git pull origin main
npm install
npm run migrate:safe
pm2 restart all --update-env
pm2 save
