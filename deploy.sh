#!/bin/bash

set -e

cd /root/discordbot || { echo "❌ Could not find bot directory."; exit 1; }

echo "📥 Pulling latest changes from GitHub main..."
git checkout main
git pull origin main

echo "📦 Installing/updating dependencies..."
npm install

echo "🚀 Deploying slash commands..."
node deploy-commands.js

echo "🔄 Restarting bot with PM2..."
pm2 restart discordbot

echo "✅ Deployment complete."
echo "🕒 Timestamp: $(date)"
