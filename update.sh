#!/bin/bash

set -e  # Exit if any command fails

# Change to bot directory if needed
cd /path/to/your/discordbot

echo "📥 Pulling latest changes from dev branch..."
git checkout dev
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
