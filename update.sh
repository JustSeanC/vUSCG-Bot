#!/bin/bash

set -e  # Exit if any command fails

cd /root/discordbot/vuscg-bot

echo "📥 Pulling latest changes from dev branch..."
git checkout dev
git add .
git commit -m "Auto-commit before merge" || echo "🔎 No local changes to commit."
git push origin dev
git pull origin dev

echo "🔁 Merging dev into main..."
git checkout main
git merge dev --no-edit

echo "📤 Pushing merged main branch to GitHub..."
git push origin main

echo "🚀 Deploying slash commands..."
node deploy-commands.js

echo "🔄 Restarting Discord bot with PM2..."
pm2 restart discordbot

echo "✅ Update, push, and restart complete!"
