# Deployment Guide - DigitalOcean + Let's Encrypt SSL

Complete guide to deploying the Evento Node API on a DigitalOcean Droplet with SSL certificate.

## Prerequisites

- DigitalOcean account
- Domain name pointed to your droplet's IP
- GitHub repository access (or alternative deployment method)

## Part 1: Create DigitalOcean Droplet

### 1.1 Create Droplet

1. Log into DigitalOcean
2. Click **Create** → **Droplets**
3. Choose configuration:
   - **Image**: Ubuntu 22.04 (LTS) x64
   - **Size**: Basic - $12/month (2GB RAM, 1 CPU) minimum
   - **Datacenter**: Choose closest to your users
   - **Authentication**: SSH keys (recommended) or Password
   - **Hostname**: `evento-api` or similar

4. Click **Create Droplet**
5. Note your droplet's IP address (e.g., `165.232.123.45`)

### 1.2 Point Domain to Droplet

Add an A record in your DNS:
```
Type: A
Host: nodeapi (or api, or @)
Value: YOUR_DROPLET_IP
TTL: 3600
```

Example: `eventoapi.com` → `165.232.123.45`

---

## Part 2: Initial Server Setup

### 2.1 SSH into Droplet

```bash
ssh root@YOUR_DROPLET_IP
```

### 2.2 Update System

```bash
apt update && apt upgrade -y
```

### 2.3 Install Node.js 20.x

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node --version  # Should show v20.x.x
npm --version
```

### 2.4 Install PM2 (Process Manager)

```bash
npm install -g pm2
```

### 2.5 Install Nginx

```bash
apt install -y nginx
systemctl enable nginx
systemctl start nginx
```

### 2.6 Configure Firewall

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```

---

## Part 3: Deploy the API

### 3.1 Create App User (Optional but Recommended)

```bash
adduser evento
usermod -aG sudo evento
su - evento
```

### 3.2 Clone Repository

```bash
cd ~
git clone https://github.com/YOUR_ORG/node-api.git
cd node-api
```

Or upload via SFTP/SCP if not using Git.

### 3.3 Install Dependencies

```bash
npm install --production
```

### 3.4 Create Production Environment File

```bash
nano .env
```

Add your production config:

```env
PORT=3000
NODE_ENV=production

# PostgreSQL (DigitalOcean Managed Database)
PG_HOST=your-db-host.db.ondigitalocean.com
PG_PORT=25061
PG_DATABASE=evento_pool
PG_USER=doadmin
PG_PASSWORD=your_secure_password
PG_SSL=true

# Redis / Valkey
REDIS_HOST=your-redis-host.db.ondigitalocean.com
REDIS_PORT=25061
REDIS_PASSWORD=your_redis_password
REDIS_TLS=true

# JWT
JWT_SECRET=your_very_long_random_jwt_secret_here

# DigitalOcean Spaces
DO_SPACES_KEY=your_spaces_key
DO_SPACES_SECRET=your_spaces_secret

# RaceResult
RR_ENCRYPTION_KEY=evento_rr_2024
```

Save and exit (Ctrl+X, Y, Enter)

### 3.5 Test the API Locally

```bash
node src/server.js
```

If it starts without errors, proceed. Press Ctrl+C to stop.

---

## Part 4: Configure PM2

### 4.1 Start with PM2

```bash
cd ~/node-api
pm2 start ecosystem.config.js --env production
```

### 4.2 Save PM2 Configuration

```bash
pm2 save
pm2 startup
```

Follow the command it prints (will setup auto-start on reboot).

### 4.3 Monitor

```bash
pm2 status
pm2 logs evento-node-api
pm2 monit
```

---

## Part 5: Configure Nginx Reverse Proxy

### 5.1 Create Nginx Config

```bash
sudo nano /etc/nginx/sites-available/evento-api
```

Add this configuration:

```nginx
server {
    listen 80;
    server_name eventoapi.com;

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
    limit_req zone=api burst=20 nodelay;

    # Logging
    access_log /var/log/nginx/evento-api.access.log;
    error_log /var/log/nginx/evento-api.error.log;

    # Proxy to Node.js
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
        
        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Health check endpoint (no rate limit)
    location /health {
        proxy_pass http://localhost:3000/health;
        access_log off;
    }
}
```

Save and exit.

### 5.2 Enable Site

```bash
sudo ln -s /etc/nginx/sites-available/evento-api /etc/nginx/sites-enabled/
sudo nginx -t  # Test config
sudo systemctl reload nginx
```

### 5.3 Test HTTP Access

Visit `http://eventoapi.com/health`

Should return: `{"status":"ok"}`

---

## Part 6: Install SSL with Let's Encrypt

### 6.1 Install Certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
```

### 6.2 Obtain SSL Certificate

```bash
sudo certbot --nginx -d eventoapi.com
```

Follow the prompts:
- Enter email address
- Agree to terms
- Choose whether to redirect HTTP to HTTPS (recommended: Yes)

### 6.3 Verify SSL

Visit `https://eventoapi.com/health`

Should now work with HTTPS! 🔒

### 6.4 Auto-Renewal

Certbot automatically sets up renewal. Test it:

```bash
sudo certbot renew --dry-run
```

If successful, certificates will auto-renew before expiry.

---

## Part 7: Final Nginx Configuration (After SSL)

After Certbot runs, your config will be updated. Optionally enhance it:

```bash
sudo nano /etc/nginx/sites-available/evento-api
```

Your config should now look like this (Certbot adds the SSL parts):

```nginx
server {
    server_name eventoapi.com;

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
    limit_req zone=api burst=20 nodelay;

    # Logging
    access_log /var/log/nginx/evento-api.access.log;
    error_log /var/log/nginx/evento-api.error.log;

    # Proxy to Node.js
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

    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/eventoapi.com/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/eventoapi.com/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
}

server {
    if ($host = eventoapi.com) {
        return 301 https://$host$request_uri;
    } # managed by Certbot

    listen 80;
    server_name eventoapi.com;
    return 404; # managed by Certbot
}
```

Reload nginx:
```bash
sudo nginx -t
sudo systemctl reload nginx
```

---

## Part 8: Deployment Workflow

### 8.1 Deploy Updates

```bash
cd ~/node-api
git pull origin main
npm install --production
pm2 restart evento-node-api
```

### 8.2 View Logs

```bash
pm2 logs evento-node-api
pm2 logs evento-node-api --lines 100
```

### 8.3 Check Status

```bash
pm2 status
curl https://eventoapi.com/health
```

---

## Part 9: Monitoring & Maintenance

### 9.1 Set up PM2 Monitoring

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

### 9.2 System Monitoring

Check disk space:
```bash
df -h
```

Check memory:
```bash
free -m
```

Check processes:
```bash
pm2 monit
```

### 9.3 Nginx Logs

```bash
sudo tail -f /var/log/nginx/evento-api.access.log
sudo tail -f /var/log/nginx/evento-api.error.log
```

---

## Part 10: Security Hardening

### 10.1 Disable Root Login

```bash
sudo nano /etc/ssh/sshd_config
```

Change:
```
PermitRootLogin no
```

Restart SSH:
```bash
sudo systemctl restart sshd
```

### 10.2 Install Fail2Ban

```bash
sudo apt install -y fail2ban
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

### 10.3 Enable Automatic Security Updates

```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades
```

---

## Troubleshooting

### API Won't Start

```bash
pm2 logs evento-node-api --err
# Check for database connection errors
```

### SSL Issues

```bash
sudo certbot certificates  # Check cert status
sudo certbot renew --dry-run  # Test renewal
```

### Nginx Issues

```bash
sudo nginx -t  # Test config
sudo systemctl status nginx
sudo tail -f /var/log/nginx/error.log
```

### Database Connection

Test from droplet:
```bash
node << 'EOF'
require('dotenv').config();
const { Client } = require('pg');
const client = new Client({
  host: process.env.PG_HOST,
  port: process.env.PG_PORT,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  ssl: { rejectUnauthorized: false }
});
client.connect()
  .then(() => console.log('✓ Database connected'))
  .catch(err => console.error('✗ Database error:', err.message))
  .finally(() => client.end());
EOF
```

---

## Quick Command Reference

```bash
# PM2
pm2 restart evento-node-api
pm2 logs evento-node-api
pm2 status
pm2 monit

# Nginx
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl restart nginx

# SSL
sudo certbot certificates
sudo certbot renew

# Updates
cd ~/node-api && git pull && npm install --production && pm2 restart evento-node-api
```

---

## Done! 🎉

Your API is now running at:
- **HTTPS**: `https://eventoapi.com`
- **Health check**: `https://eventoapi.com/health`

SSL certificate auto-renews every 90 days.

PM2 auto-restarts on crashes and server reboots.
