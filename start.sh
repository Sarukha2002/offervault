#!/bin/bash
set -e
cd "$(dirname "$0")"
echo "Installing dependencies..."
npm install
echo "Starting OfferVault at http://localhost:3000 ..."
npm run dev
