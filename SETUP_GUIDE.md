# Evento Node API - Setup Guide

## Quick Start: Testing Droplet with Let's Encrypt

### Prerequisites
1. DigitalOcean account with `doctl` installed and authenticated
2. Domain `eventoapi.com` DNS configured (see below)
3. PostgreSQL and Redis databases (DigitalOcean managed databases recommended)

### DNS Configuration
Add these A records before running setup:
```
Type: A
Host: @
Value: [YOUR_DROPLET_IP]

Type: A  
Host: www
Value: [YOUR_DROPLET_IP]
```

### Run Setup
```bash
cd /Users/toddgiles/Projects/EventoWorkspace/node-api
chmod +x setup-droplet.sh
./setup-droplet.sh
```

The script will:
1. Create a new droplet in Sydney (`syd1`)
2. Install Node.js 20, PM2, Nginx, Certbot
3. Deploy the API code
4. Configure environment variables (you'll be prompted)
5. Start the API with PM2
6. Set up Nginx with Let's Encrypt SSL

### Cost
- **Droplet**: $6/month (1GB RAM, 1 vCPU)
- **SSL**: Free (Let's Encrypt)
- **Total**: $6/month

---

## Production: Switching to Load Balancer

When ready to scale with a DO Load Balancer:

### 1. Create Load Balancer
In DigitalOcean:
- Create Load Balancer in same region as droplet
- Add your droplet to the load balancer pool
- Configure health check: `/health` endpoint
- Add SSL certificate for `eventoapi.com`

### 2. Update DNS
Point DNS to Load Balancer IP instead of droplet IP

### 3. Switch Nginx Config
SSH into droplet:
```bash
ssh root@[DROPLET_IP]
cd /etc/nginx/sites-available/
cp /root/node-api/nginx-loadbalancer.conf ./evento-api
nginx -t
systemctl reload nginx

# Remove Let's Encrypt certs (no longer needed)
certbot delete --cert-name eventoapi.com
```

### 4. Update Firewall
Load balancer is now the only entry point:
```bash
# Only allow LB to access the droplet
ufw delete allow 'Nginx Full'
ufw allow from [LB_IP] to any port 80
```

### Cost
- **Droplet**: $6/month
- **Load Balancer**: $12/month  
- **SSL**: Included in LB
- **Total**: $18/month

---

## Configuration Files

| File | Purpose |
|------|---------|
| `nginx-standalone.conf` | For testing: SSL via Let's Encrypt on droplet |
| `nginx-loadbalancer.conf` | For production: SSL terminated at LB |
| `setup-droplet.sh` | Automated droplet setup with Let's Encrypt |
| `DEPLOY.sh` | Quick deployment script for code updates |

---

## Useful Commands

### On Droplet
```bash
# PM2
pm2 status
pm2 logs evento-node-api
pm2 restart evento-node-api

# Nginx
nginx -t
systemctl status nginx
systemctl reload nginx

# Logs
tail -f /var/log/nginx/evento-api.error.log
tail -f /var/log/nginx/evento-api.access.log

# SSL Certificate
certbot certificates
certbot renew --dry-run
```

### Local Testing
```bash
# Health check
curl https://eventoapi.com/health

# Test endpoint (requires Bearer token)
curl -H "Authorization: Bearer YOUR_TOKEN" https://eventoapi.com/v1/events
```

---

## Environment Variables

Required in `/root/node-api/.env`:

```bash
PORT=3000
NODE_ENV=production

# PostgreSQL
PG_HOST=your-db.db.ondigitalocean.com
PG_PORT=25061
PG_DATABASE=evento_pool
PG_USER=doadmin
PG_PASSWORD=your_password
PG_SSL=true

# Redis
REDIS_HOST=your-redis.db.ondigitalocean.com
REDIS_PORT=25061
REDIS_PASSWORD=your_password
REDIS_TLS=true

# JWT
JWT_SECRET=your_random_secret_string

# RaceResult
RR_ENCRYPTION_KEY=evento_rr_2024
```

---

## Troubleshooting

### API not responding
```bash
pm2 logs evento-node-api --lines 50
systemctl status nginx
curl http://localhost:3000/health
```

### SSL certificate issues
```bash
certbot certificates
certbot renew --dry-run
nginx -t
```

### DNS not resolving
```bash
dig eventoapi.com
curl -I http://[DROPLET_IP]/health
```
