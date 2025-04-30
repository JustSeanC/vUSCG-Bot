#!/bin/bash

echo "🚀 Deploying slash commands..."
node deploy-commands.js

echo "🔄 Restarting Discord bot..."
pm2 restart discordbot

echo "✅ Update complete!"

