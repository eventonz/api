# Automated Droplet Setup

## Quick Start

Run this one command to create and configure everything:

```bash
cd /Users/toddgiles/Projects/EventoWorkspace/node-api
./setup-droplet.sh
```

## What It Does

✅ Creates DigitalOcean droplet ($6/month - 1GB RAM)  
✅ Installs Node.js 20.x  
✅ Installs PM2, Nginx, Certbot  
✅ Deploys your API code  
✅ Configures SSL for `eventoapi.com`  
✅ Sets up auto-restart and monitoring  

## Requirements

- `doctl` authenticated (already done ✓)
- SSH key added to DigitalOcean (will check automatically)
- Domain `eventoapi.com` (already in DO ✓)

## Configuration

**Droplet:**
- Name: `evento-node-api`
- Size: `s-1vcpu-1gb` (1GB RAM, 1 vCPU, 25GB disk)
- Price: $6/month
- Region: Sydney (syd1)
- OS: Ubuntu 22.04

**Domain:**
- `eventoapi.com` → Will auto-configure DNS A record

**SSL:**
- Free Let's Encrypt certificate
- Auto-renewal every 90 days

## During Setup

The script will prompt you for:
1. Database credentials (PostgreSQL)
2. Redis credentials  
3. JWT secret (or auto-generate)

## After Setup

Access your API at:
- **HTTPS**: `https://eventoapi.com/health`
- **SSH**: `ssh root@DROPLET_IP`

## Manual Steps (if needed)

If the script skips SSL or DNS, you can configure manually:

### DNS (if auto-config fails)
```bash
# Get droplet IP
doctl compute droplet list | grep evento-node-api

# Add A record
doctl compute domain records create eventoapi.com \
  --record-type A \
  --record-name @ \
  --record-data DROPLET_IP \
  --record-ttl 3600
```

### SSL (if skipped)
```bash
ssh root@DROPLET_IP
certbot --nginx -d eventoapi.com --email tech@eventonz.co.nz
```

## Next Steps After Setup

```bash
# SSH into droplet
ssh root@$(doctl compute droplet list --format Name,PublicIPv4 --no-header | grep evento-node-api | awk '{print $2}')

# Generate API key
cd /root/node-api
node scripts/generate-key.js "Mobile App"

# Check status
pm2 status
pm2 logs evento-node-api

# Test API
curl https://eventoapi.com/health
```

## Estimated Time

- Droplet creation: 1-2 minutes
- Setup & configuration: 5-10 minutes
- **Total: ~10-15 minutes**

## Cost

**$6/month** for the droplet (1GB RAM, 25GB disk, 1TB transfer)

This size is perfect for a production Node.js API with comfortable memory headroom.
