#!/bin/bash
#
# Automated DigitalOcean Droplet Setup for Evento Node API
# Uses doctl to create and configure everything
#

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
DROPLET_NAME="evento-node-api"
DROPLET_SIZE="s-1vcpu-1gb"  # $6/month - 1GB RAM, 1 vCPU, 25GB disk
DROPLET_IMAGE="ubuntu-22-04-x64"
DROPLET_REGION="syd1"  # Sydney - change as needed
DOMAIN="eventoapi.com"  # Your domain
EMAIL="tech@eventonz.co.nz"  # For Let's Encrypt

echo -e "${GREEN}🚀 Evento Node API - Automated Droplet Setup${NC}"
echo "=================================================="
echo ""

# Check if doctl is authenticated
echo -e "${YELLOW}Checking doctl authentication...${NC}"
if ! doctl account get &> /dev/null; then
    echo -e "${RED}Error: doctl is not authenticated${NC}"
    echo "Run: doctl auth init"
    exit 1
fi
echo -e "${GREEN}✓ doctl authenticated${NC}"

# Get SSH keys
echo -e "${YELLOW}Fetching your SSH keys...${NC}"
SSH_KEY_IDS=$(doctl compute ssh-key list --format ID --no-header | tr '\n' ',' | sed 's/,$//')
if [ -z "$SSH_KEY_IDS" ]; then
    echo -e "${RED}Error: No SSH keys found in your DigitalOcean account${NC}"
    echo "Add one at: https://cloud.digitalocean.com/account/security"
    exit 1
fi
echo -e "${GREEN}✓ Found SSH keys: $SSH_KEY_IDS${NC}"

# Check if droplet already exists
echo -e "${YELLOW}Checking if droplet already exists...${NC}"
EXISTING_DROPLET=$(doctl compute droplet list --format Name --no-header | grep "^${DROPLET_NAME}$" || true)
if [ ! -z "$EXISTING_DROPLET" ]; then
    echo -e "${RED}Error: Droplet '${DROPLET_NAME}' already exists${NC}"
    echo "Delete it first or choose a different name"
    exit 1
fi

# Create droplet
echo ""
echo -e "${GREEN}Creating droplet...${NC}"
echo "  Name: $DROPLET_NAME"
echo "  Size: $DROPLET_SIZE"
echo "  Region: $DROPLET_REGION"
echo "  Image: $DROPLET_IMAGE"
echo ""

doctl compute droplet create "$DROPLET_NAME" \
    --size "$DROPLET_SIZE" \
    --image "$DROPLET_IMAGE" \
    --region "$DROPLET_REGION" \
    --ssh-keys "$SSH_KEY_IDS" \
    --wait

echo -e "${GREEN}✓ Droplet created${NC}"

# Get droplet IP
echo -e "${YELLOW}Getting droplet IP address...${NC}"
sleep 5  # Give it a moment
DROPLET_IP=$(doctl compute droplet list --format Name,PublicIPv4 --no-header | grep "^${DROPLET_NAME}" | awk '{print $2}')

if [ -z "$DROPLET_IP" ]; then
    echo -e "${RED}Error: Could not get droplet IP${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Droplet IP: $DROPLET_IP${NC}"

# Wait for SSH to be ready
echo -e "${YELLOW}Waiting for SSH to be ready...${NC}"
sleep 30
MAX_RETRIES=10
RETRY_COUNT=0
while ! ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 root@$DROPLET_IP "echo 'SSH ready'" &> /dev/null; do
    RETRY_COUNT=$((RETRY_COUNT + 1))
    if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
        echo -e "${RED}Error: SSH did not become ready in time${NC}"
        exit 1
    fi
    echo "  Attempt $RETRY_COUNT/$MAX_RETRIES..."
    sleep 10
done
echo -e "${GREEN}✓ SSH is ready${NC}"

# DNS reminder
echo ""
echo -e "${YELLOW}⚠️  IMPORTANT: DNS Configuration${NC}"
echo "Add this A record to your DNS:"
echo "  Type: A"
echo "  Host: nodeapi (or your subdomain)"
echo "  Value: $DROPLET_IP"
echo "  TTL: 3600"
echo ""
read -p "Press ENTER once DNS is configured (or to continue anyway)..."

# Create setup script
echo -e "${GREEN}Creating server setup script...${NC}"
cat > /tmp/evento-setup.sh << 'SETUP_SCRIPT'
#!/bin/bash
set -e

echo "🔧 Setting up server..."

# Update system
echo "Updating system..."
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get upgrade -y

# Install Node.js 20.x
echo "Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Install PM2
echo "Installing PM2..."
npm install -g pm2

# Install Nginx
echo "Installing Nginx..."
apt-get install -y nginx

# Install Certbot
echo "Installing Certbot..."
apt-get install -y certbot python3-certbot-nginx

# Configure firewall
echo "Configuring firewall..."
ufw --force enable
ufw allow OpenSSH
ufw allow 'Nginx Full'

# Install fail2ban
echo "Installing fail2ban..."
apt-get install -y fail2ban
systemctl enable fail2ban
systemctl start fail2ban

# Install unattended upgrades
echo "Enabling automatic security updates..."
apt-get install -y unattended-upgrades
echo 'Unattended-Upgrade::Automatic-Reboot "false";' > /etc/apt/apt.conf.d/51custom-unattended-upgrades

echo "✓ Server setup complete"
SETUP_SCRIPT

# Upload and run setup script
echo -e "${GREEN}Running server setup (this will take a few minutes)...${NC}"
scp -o StrictHostKeyChecking=no /tmp/evento-setup.sh root@$DROPLET_IP:/tmp/setup.sh
ssh -o StrictHostKeyChecking=no root@$DROPLET_IP "bash /tmp/setup.sh"
echo -e "${GREEN}✓ Server setup complete${NC}"

# Create app directory and deploy
echo -e "${GREEN}Deploying API code...${NC}"

# Create deployment script
cat > /tmp/deploy-api.sh << 'DEPLOY_SCRIPT'
#!/bin/bash
set -e

cd /root

# Clone or update repository
if [ -d "node-api" ]; then
    echo "Updating repository..."
    cd node-api
    git pull
else
    echo "Cloning repository..."
    # Note: You'll need to configure git access if private repo
    git clone https://github.com/YOUR_ORG/node-api.git
    cd node-api
fi

# Install dependencies
echo "Installing dependencies..."
npm install --production

echo "✓ Code deployed"
DEPLOY_SCRIPT

ssh root@$DROPLET_IP "bash -s" < /tmp/deploy-api.sh

echo -e "${GREEN}✓ API code deployed${NC}"

# Setup environment variables
echo -e "${YELLOW}Setting up environment variables...${NC}"
echo ""
echo "I'll now prompt you for the required environment variables."
echo "Press CTRL+C to cancel and configure manually later."
echo ""

read -p "PostgreSQL Host: " PG_HOST
read -p "PostgreSQL Port [25061]: " PG_PORT
PG_PORT=${PG_PORT:-25061}
read -p "PostgreSQL Database: " PG_DATABASE
read -p "PostgreSQL User: " PG_USER
read -sp "PostgreSQL Password: " PG_PASSWORD
echo ""
read -p "Redis Host: " REDIS_HOST
read -p "Redis Port [25061]: " REDIS_PORT
REDIS_PORT=${REDIS_PORT:-25061}
read -sp "Redis Password: " REDIS_PASSWORD
echo ""
read -sp "JWT Secret (or press enter for auto-generate): " JWT_SECRET
echo ""
if [ -z "$JWT_SECRET" ]; then
    JWT_SECRET=$(openssl rand -hex 32)
    echo "Generated JWT Secret: $JWT_SECRET"
fi

# Create .env file
cat > /tmp/.env << ENV_FILE
PORT=3000
NODE_ENV=production

# PostgreSQL
PG_HOST=$PG_HOST
PG_PORT=$PG_PORT
PG_DATABASE=$PG_DATABASE
PG_USER=$PG_USER
PG_PASSWORD=$PG_PASSWORD
PG_SSL=true

# Redis
REDIS_HOST=$REDIS_HOST
REDIS_PORT=$REDIS_PORT
REDIS_PASSWORD=$REDIS_PASSWORD
REDIS_TLS=true

# JWT
JWT_SECRET=$JWT_SECRET

# RaceResult
RR_ENCRYPTION_KEY=evento_rr_2024
ENV_FILE

scp /tmp/.env root@$DROPLET_IP:/root/node-api/.env
echo -e "${GREEN}✓ Environment configured${NC}"

# Start with PM2
echo -e "${GREEN}Starting API with PM2...${NC}"
ssh root@$DROPLET_IP << 'SSH_COMMANDS'
cd /root/node-api
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup systemd -u root --hp /root
SSH_COMMANDS
echo -e "${GREEN}✓ PM2 configured${NC}"

# Configure Nginx
echo -e "${GREEN}Configuring Nginx...${NC}"
# Use the standalone config (handles SSL via Let's Encrypt)
scp nginx-standalone.conf root@$DROPLET_IP:/etc/nginx/sites-available/evento-api
ssh root@$DROPLET_IP << 'SSH_COMMANDS'
ln -sf /etc/nginx/sites-available/evento-api /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
# Comment out SSL directives until certbot adds certificates
sed -i 's/^\s*listen 443/#&/' /etc/nginx/sites-available/evento-api
sed -i 's/^\s*ssl_/#&/' /etc/nginx/sites-available/evento-api
nginx -t
systemctl reload nginx
SSH_COMMANDS
echo -e "${GREEN}✓ Nginx configured${NC}"

# Test HTTP
echo -e "${YELLOW}Testing HTTP access...${NC}"
sleep 2
if curl -s http://$DROPLET_IP/health | grep -q "ok"; then
    echo -e "${GREEN}✓ API responding on HTTP${NC}"
else
    echo -e "${RED}⚠️  API not responding - check logs${NC}"
fi

# Setup SSL
echo ""
echo -e "${GREEN}Setting up Let's Encrypt SSL...${NC}"
echo "This will obtain an SSL certificate for: $DOMAIN and www.$DOMAIN"
read -p "Continue? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    # Uncomment SSL directives before running certbot
    ssh root@$DROPLET_IP << 'SSH_COMMANDS'
sed -i 's/^#\s*\(listen 443\)/\1/' /etc/nginx/sites-available/evento-api
sed -i 's/^#\s*\(ssl_\)/\1/' /etc/nginx/sites-available/evento-api
SSH_COMMANDS
    ssh root@$DROPLET_IP "certbot --nginx -d $DOMAIN -d www.$DOMAIN --non-interactive --agree-tos --email $EMAIL"
    echo -e "${GREEN}✓ SSL certificate obtained${NC}"

    # Test HTTPS
    echo -e "${YELLOW}Testing HTTPS access...${NC}"
    sleep 2
    if curl -s https://$DOMAIN/health | grep -q "ok"; then
        echo -e "${GREEN}✓ API responding on HTTPS${NC}"
    else
        echo -e "${RED}⚠️  HTTPS not working - may need DNS propagation time${NC}"
    fi
else
    echo -e "${YELLOW}Skipped SSL setup - run manually: certbot --nginx -d $DOMAIN${NC}"
fi

# Cleanup
rm -f /tmp/evento-setup.sh /tmp/deploy-api.sh /tmp/.env

# Final summary
echo ""
echo -e "${GREEN}=================================================="
echo "✅ Setup Complete!"
echo "==================================================${NC}"
echo ""
echo "Droplet Details:"
echo "  Name: $DROPLET_NAME"
echo "  IP: $DROPLET_IP"
echo "  Domain: $DOMAIN"
echo ""
echo "Access:"
echo "  SSH: ssh root@$DROPLET_IP"
echo "  HTTP: http://$DOMAIN"
echo "  HTTPS: https://$DOMAIN"
echo ""
echo "Useful Commands:"
echo "  pm2 status"
echo "  pm2 logs evento-node-api"
echo "  pm2 restart evento-node-api"
echo "  nginx -t"
echo "  systemctl status nginx"
echo ""
echo "Next Steps:"
echo "  1. Verify DNS is pointing to $DROPLET_IP"
echo "  2. Test API: curl https://$DOMAIN/health"
echo "  3. Generate API key: cd /root/node-api && node scripts/generate-key.js 'Mobile App'"
echo ""
echo -e "${GREEN}🎉 All done!${NC}"
