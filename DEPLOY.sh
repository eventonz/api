#!/bin/bash
#
# Quick deployment script for Evento Node API
# Run on DigitalOcean droplet after initial setup
#
# Usage: ssh root@YOUR_DROPLET_IP 'cd /root/node-api && bash DEPLOY.sh'

set -e  # Exit on error

echo "🚀 Deploying Evento Node API..."

# Pull latest code
echo "📥 Pulling latest code..."
git pull origin main

# Install dependencies
echo "📦 Installing dependencies..."
npm install --production

# Restart PM2
echo "🔄 Restarting API..."
pm2 restart evento-node-api

# Wait a moment
sleep 2

# Check status
echo "✅ Deployment complete!"
echo ""
echo "Status:"
pm2 status

echo ""
echo "Recent logs:"
pm2 logs evento-node-api --lines 20 --nostream

echo ""
echo "Health check:"
curl -s https://eventoapi.com/health | jq '.'

echo ""
echo "✨ All done!"
