# Fix GitHub Actions Deployment to Droplet

Your GitHub Actions workflow exists at `.github/workflows/deploy.yml` but needs GitHub Secrets configured.

## Current Setup

**GitHub Repo**: `git@github.com:eventonz/api.git`  
**Workflow**: Deploys on push to `main` branch  
**Target**: DigitalOcean droplet at `/root/node-api`

---

## Step 1: Get Your Droplet IP Address

```bash
# Option 1: Using doctl CLI
doctl compute droplet list | grep evento-node-api

# Option 2: DigitalOcean Dashboard
# Go to https://cloud.digitalocean.com/droplets
# Find "evento-node-api" droplet and copy IP address
```

**Save this IP for Step 3.**

---

## Step 2: Generate/Get SSH Key for GitHub Actions

You need an SSH key that GitHub Actions can use to connect to your droplet.

### Option A: Use Existing SSH Key (Recommended if you already have one)

```bash
# Check if you have a key already
cat ~/.ssh/id_rsa

# Copy the ENTIRE private key (including BEGIN/END lines)
cat ~/.ssh/id_rsa | pbcopy  # Copies to clipboard on Mac
```

### Option B: Generate New SSH Key (If needed)

```bash
# Generate new key pair
ssh-keygen -t rsa -b 4096 -C "github-actions" -f ~/.ssh/github_actions_deploy

# Copy the public key to your droplet
ssh-copy-id -i ~/.ssh/github_actions_deploy.pub root@<DROPLET_IP>

# Or manually add to droplet:
cat ~/.ssh/github_actions_deploy.pub
# Then SSH to droplet and add to /root/.ssh/authorized_keys

# Copy the private key for GitHub
cat ~/.ssh/github_actions_deploy | pbcopy
```

---

## Step 3: Add GitHub Secrets

Go to your GitHub repo: **https://github.com/eventonz/api/settings/secrets/actions**

Click **"New repository secret"** and add these TWO secrets:

### Secret 1: `DROPLET_HOST`
- **Name**: `DROPLET_HOST`
- **Value**: Your droplet IP address (e.g., `134.199.146.119`)

### Secret 2: `DROPLET_SSH_KEY`
- **Name**: `DROPLET_SSH_KEY`
- **Value**: Your SSH private key (entire contents, including `-----BEGIN` and `-----END` lines)

**Screenshot reference**:
```
Repository → Settings → Secrets and variables → Actions → New repository secret
```

---

## Step 4: Verify Droplet Setup

SSH into your droplet and make sure everything is set up:

```bash
ssh root@<DROPLET_IP>

# Check if node-api directory exists and is a git repo
cd /root/node-api
git status

# If NOT a git repo yet, clone it:
cd /root
git clone git@github.com:eventonz/api.git node-api
cd node-api

# Make sure the droplet has SSH access to GitHub
ssh -T git@github.com
# Should see: "Hi eventonz! You've successfully authenticated"

# If that fails, add GitHub to known hosts:
ssh-keyscan github.com >> ~/.ssh/known_hosts

# Install dependencies
npm install --production

# Make sure PM2 is running
pm2 status
# Should see "evento-api" process

# If not running, start it:
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

---

## Step 5: Test the Deployment

Make a small change and push to test:

```bash
# In your local node-api folder
cd /Users/toddgiles/Projects/EventoWorkspace/node-api

# Make a small change (or create a test file)
echo "# Test deployment" >> DEPLOYMENT_TEST.md

# Commit and push to main
git add .
git commit -m "Test GitHub Actions deployment"
git push origin main
```

**Check GitHub Actions**:
1. Go to https://github.com/eventonz/api/actions
2. You should see your workflow running
3. Click on it to see logs
4. Should complete in ~30-60 seconds

---

## Step 6: Verify on Droplet

```bash
ssh root@<DROPLET_IP>
cd /root/node-api

# Check if latest commit is there
git log -1

# Check if PM2 restarted
pm2 logs evento-api --lines 20
```

---

## Troubleshooting

### Error: "Host key verification failed"

**Solution**: Add GitHub to droplet's known hosts:
```bash
ssh root@<DROPLET_IP>
ssh-keyscan github.com >> ~/.ssh/known_hosts
```

### Error: "Permission denied (publickey)"

**Solution**: Make sure the SSH key in GitHub Secrets has access to the droplet:
```bash
# Test the key locally first
ssh -i ~/.ssh/id_rsa root@<DROPLET_IP>

# If that works, copy that EXACT key to GitHub Secrets
```

### Error: "pm2 command not found"

**Solution**: Install PM2 globally on droplet:
```bash
ssh root@<DROPLET_IP>
npm install -g pm2
```

### Error: "fatal: not a git repository"

**Solution**: Clone the repo on the droplet:
```bash
ssh root@<DROPLET_IP>
cd /root
git clone git@github.com:eventonz/api.git node-api
```

### GitHub Actions Shows "git pull" Failing

**Solution**: Droplet needs SSH access to GitHub:
```bash
ssh root@<DROPLET_IP>

# Generate SSH key on droplet if needed
ssh-keygen -t rsa -b 4096 -C "droplet-deploy"

# Copy the public key
cat ~/.ssh/id_rsa.pub

# Add this key to GitHub:
# Go to https://github.com/eventonz/api/settings/keys
# Click "Add deploy key"
# Paste the public key
# ✅ Check "Allow write access" (so it can pull)
```

---

## Workflow Breakdown

Here's what happens when you push to `main`:

1. **GitHub detects push** to `main` branch
2. **Spins up Ubuntu runner** (GitHub's server)
3. **Connects to droplet via SSH** using `DROPLET_HOST` and `DROPLET_SSH_KEY`
4. **Runs commands on droplet**:
   ```bash
   cd /root/node-api
   git pull origin main        # Get latest code
   npm install --production    # Install/update dependencies
   pm2 restart evento-api      # Restart app (zero-downtime)
   ```
5. **Shows "✅ Deployment complete"** in logs

---

## Quick Checklist

- [ ] Droplet IP address identified
- [ ] SSH key copied (private key with BEGIN/END lines)
- [ ] `DROPLET_HOST` secret added to GitHub
- [ ] `DROPLET_SSH_KEY` secret added to GitHub
- [ ] Git repo exists on droplet at `/root/node-api`
- [ ] Droplet can access GitHub (SSH key added as deploy key)
- [ ] PM2 is running on droplet
- [ ] Test push triggers workflow
- [ ] Workflow completes successfully
- [ ] Changes appear on droplet

---

## Alternative: Manual Deploy Script

If GitHub Actions is giving you trouble, you can deploy manually:

```bash
# On your local machine
cd /Users/toddgiles/Projects/EventoWorkspace/node-api
./DEPLOY.sh <DROPLET_IP>
```

This will SSH to the droplet and run the same commands.

---

Need help? Check the workflow logs at: https://github.com/eventonz/api/actions
