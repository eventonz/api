# Testing Multiple PM2 Instances

Your API is now running **2 instances** in cluster mode:
- **Instance 0** (PID 24177)
- **Instance 1** (PID 25045)

## 1. Check Instance Status

```bash
ssh root@134.199.152.100 "pm2 list"
```

Look for multiple rows with same name but different `id` and `pid`.

## 2. Monitor Real-Time CPU/Memory per Instance

```bash
ssh root@134.199.152.100 "pm2 monit"
```

This shows live metrics for each instance side-by-side.

## 3. Send Load and Watch Distribution

### Option A: Simple Load Test
```bash
# Send 1000 requests
for i in {1..1000}; do
  curl -s https://eventoapi.com/health > /dev/null &
done
wait

# Check which instance handled more requests
ssh root@134.199.152.100 "pm2 logs evento-api --lines 100 | grep -c 'GET /health'"
```

### Option B: Apache Bench (Better)
```bash
# Install if needed
brew install httpd

# 1000 requests, 50 concurrent
ab -n 1000 -c 50 https://eventoapi.com/health

# Then check PM2 metrics
ssh root@134.199.152.100 "pm2 describe evento-api"
```

### Option C: See Process IDs in Response (If Implemented)

Add this to your API to see which instance handled each request:

```javascript
// In Fastify route
fastify.get('/health', async (request, reply) => {
  return {
    status: 'ok',
    instance: process.pid,  // Shows which PM2 instance
    uptime: process.uptime()
  }
});
```

Then test:
```bash
# Make 10 requests and see different PIDs
for i in {1..10}; do
  curl -s https://eventoapi.com/health | jq .instance
done
```

You'll see output like:
```
24177  # Instance 0
25045  # Instance 1
24177  # Instance 0
25045  # Instance 1
...
```

## 4. Check System-Level CPU Usage

```bash
# See which cores are being used
ssh root@134.199.152.100 "top -b -n 1 | grep 'node\|PID'"
```

Or with htop (more visual):
```bash
ssh root@134.199.152.100 "htop"
# Press F5 to see tree view with all node processes
```

## 5. Stress Test with Artillery

```bash
# Install artillery
npm install -g artillery

# Create test config
cat > artillery-test.yml << EOF
config:
  target: "https://eventoapi.com"
  phases:
    - duration: 60
      arrivalRate: 20  # 20 requests per second
scenarios:
  - flow:
      - get:
          url: "/health"
EOF

# Run test
artillery run artillery-test.yml

# Watch PM2 during test
ssh root@134.199.152.100 "pm2 monit"
```

## 6. Verify Nginx Load Balancing

Check that Nginx is distributing across instances:

```bash
ssh root@134.199.152.100 "cat /etc/nginx/sites-available/evento-api.conf"
```

Should show upstream with multiple servers or pm2 socket.

## Current Setup

```
┌─────────────────────────────────────┐
│  Nginx (Port 443/80)                │
│  Load Balancer                      │
└─────────────┬───────────────────────┘
              │
      ┌───────┴───────┐
      ▼               ▼
┌─────────┐     ┌─────────┐
│ Node.js │     │ Node.js │
│ PID     │     │ PID     │
│ 24177   │     │ 25045   │
│ Port    │     │ Port    │
│ 3000    │     │ 3000    │
└─────────┘     └─────────┘
Instance 0      Instance 1
```

PM2 handles internal load balancing in cluster mode.

## Expected Results

With **1 vCPU** and **2 instances**:
- Both instances share the single CPU core
- Load balancing works, but won't improve performance
- Useful for handling crashes (one instance can fail, other continues)

With **2+ vCPUs** and **2 instances**:
- Each instance can use a dedicated core
- Better CPU utilization
- True parallel request handling

## Scale Back to Optimal

Since you have 1 vCPU, scaling back to 1 instance is more efficient:

```bash
ssh root@134.199.152.100 "pm2 scale evento-api 1"
```

Or set to auto-scale based on CPU count:
```bash
# Already configured in ecosystem.config.js
instances: 'max'  # Auto-scales to CPU count
```

## Performance Tips

**For 1 vCPU droplet**: Use 1 instance  
**For 2 vCPU droplet**: Use 2 instances  
**For 4 vCPU droplet**: Use 3-4 instances (leave 1 core for system)

**Current recommendation**: Keep at 1 instance or upgrade to 2 vCPU droplet.
