#!/bin/bash
# Evento Node API - Complete Setup Script
# Paste this entire script into your droplet console

set -e

echo "🚀 Starting Evento API Setup..."

# Update system
echo "📦 Updating system..."
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get upgrade -y

# Install Node.js
echo "📦 Installing Node.js 20.x..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Install PM2
echo "📦 Installing PM2..."
npm install -g pm2

# Install Nginx
echo "📦 Installing Nginx..."
apt-get install -y nginx

# Install Certbot
echo "📦 Installing Certbot..."
apt-get install -y certbot python3-certbot-nginx

# Install other tools
apt-get install -y git fail2ban unattended-upgrades curl jq

# Configure firewall
echo "🔒 Configuring firewall..."
ufw --force enable
ufw allow OpenSSH
ufw allow 'Nginx Full'
systemctl enable fail2ban
systemctl start fail2ban

# Clone API code
echo "📥 Setting up API code..."
cd /root

if [ -d "node-api" ]; then
    echo "node-api directory already exists, skipping clone"
    cd node-api
else
    # Create directory structure
    mkdir -p node-api
    cd node-api

    # Create basic structure (we'll add code later)
    mkdir -p src scripts docs
fi

# Create .env file
echo "📝 Creating environment configuration..."
cat > .env << 'ENVFILE'
PORT=3000
NODE_ENV=production

# PostgreSQL (update these values)
PG_HOST=your-db-host.db.ondigitalocean.com
PG_PORT=25061
PG_DATABASE=evento_pool
PG_USER=doadmin
PG_PASSWORD=CHANGE_ME
PG_SSL=true

# Redis (update these values)
REDIS_HOST=your-redis-host.db.ondigitalocean.com
REDIS_PORT=25061
REDIS_PASSWORD=CHANGE_ME
REDIS_TLS=true

# JWT Secret (update this)
JWT_SECRET=CHANGE_ME_TO_RANDOM_STRING

# RaceResult
RR_ENCRYPTION_KEY=evento_rr_2024
ENVFILE

echo "✅ .env file created at /root/node-api/.env"

# Configure Nginx
echo "🌐 Configuring Nginx..."
cat > /etc/nginx/sites-available/evento-api << 'NGINXCONF'
server {
    listen 80;
    server_name eventoapi.com www.eventoapi.com;

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
    limit_req zone=api burst=20 nodelay;

    access_log /var/log/nginx/evento-api.access.log;
    error_log /var/log/nginx/evento-api.error.log;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    location /health {
        proxy_pass http://localhost:3000/health;
        access_log off;
    }
}
NGINXCONF

ln -sf /etc/nginx/sites-available/evento-api /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo ""
echo "=================================================="
echo "✅ Server Setup Complete!"
echo "=================================================="
echo ""
echo "Droplet IP: $(curl -s ifconfig.me)"
echo ""
echo "📋 NEXT STEPS:"
echo ""
echo "1. Update DNS for eventoapi.com to point to this IP"
echo ""
echo "2. Edit /root/node-api/.env with your credentials:"
echo "   nano /root/node-api/.env"
echo ""
echo "3. Upload your API code to /root/node-api/"
echo "   (or clone from git if you have access)"
echo ""
echo "4. Install dependencies:"
echo "   cd /root/node-api && npm install --production"
echo ""
echo "5. Start API with PM2:"
echo "   pm2 start ecosystem.config.js --env production"
echo "   pm2 save"
echo "   pm2 startup"
echo ""
echo "6. Get SSL certificate:"
echo "   certbot --nginx -d eventoapi.com -d www.eventoapi.com --email tech@eventonz.co.nz --agree-tos --redirect"
echo ""
echo "=================================================="
