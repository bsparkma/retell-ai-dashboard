# Troubleshooting Guide - Retell AI Dashboard

**🔧 Complete guide for diagnosing and fixing common issues with your production deployment.**

## 🚨 Quick Health Check

If something's not working, start here:

| Step | Command | Expected Result |
|------|---------|----------------|
| **1. Connect** | `ssh root@159.89.82.167` | SSH connection successful |
| **2. Services** | `pm2 status` | 2 services online (retell-backend, retell-frontend) |
| **3. Web Server** | `sudo systemctl status nginx` | Active (running) |
| **4. API Test** | `curl http://localhost:5000/api/calls` | JSON data with real calls |

**🔍 If any step fails, see the specific issue below.**

---

## 🎯 Most Common Issues

### 🥲 **Issue #1: Dashboard Shows Mock Data Instead of Real Calls**

**Symptoms:**
- Dashboard loads but shows fake/sample data
- No real Retell AI calls visible  
- Data looks generic (e.g., "Sample Call #1")

| Diagnosis Step | Command | What to Look For |
|----------------|---------|-------------------|
| **Frontend Environment** | `cd /root/retell-ai-dashboard/frontend && cat .env` | Should show `REACT_APP_API_URL=http://159.89.82.167/api` |
| **Backend API** | `curl http://localhost:5000/api/calls \| head -20` | Real call data, not mock data |
| **Frontend Connection** | `curl http://159.89.82.167/api/calls \| head -20` | Same data as backend test |

**Solutions:**

#### **A. Missing Frontend Environment Variable** ⚡ *(2 minutes)*
```bash
cd /root/retell-ai-dashboard/frontend
echo "REACT_APP_API_URL=http://159.89.82.167/api" > .env
pm2 restart retell-frontend
```

#### **B. Backend Not Connected to Retell** ⚙️ *(5 minutes)*
```bash
cd /root/retell-ai-dashboard/backend
cat .env  # Verify RETELL_API_KEY is correct
pm2 logs retell-backend  # Check for API errors
pm2 restart retell-backend
```

#### **C. Network Connectivity Issues** 🌐 *(Test)*
```bash
# Test Retell API directly from server
curl -H "Authorization: Bearer key_5286e8b619b00ed6815991eba586" \
     -H "Content-Type: application/json" \
     -X POST https://api.retellai.com/v2/list-calls \
     -d '{"limit": 5}'
```

---

### 💾 **Issue #2: React Build Fails on Server**

**Symptoms:**
- `npm run build` fails with memory error
- "The build failed because the process exited too early"
- Server becomes unresponsive during build

**Why This Happens:**
- 1GB RAM is insufficient for React builds
- React compilation requires ~2GB+ memory

**✅ Solution: Always Build Locally** *(5-10 minutes)*

```powershell
# 🖥️ On your local Windows machine:
cd frontend
$env:REACT_APP_API_URL="http://159.89.82.167/api"
npm run build

# 📤 Upload to server:
scp -r build\* root@159.89.82.167:/root/retell-ai-dashboard/frontend/build/

# 🔄 Restart frontend:
ssh root@159.89.82.167 "pm2 restart retell-frontend"
```

**Alternative (if you have more RAM):**
```bash
NODE_OPTIONS="--max-old-space-size=512" npm run build
```

---

### 🔗 **Issue #3: SSH Connection Issues**

**Symptoms:**
- Connection timeout
- "Connection refused"  
- Lost SSH session

| Problem | Solution | Command |
|---------|----------|---------|
| **Connection Timeout** | Try different network/client | `ssh -v root@159.89.82.167` |
| **Lost Session** | Simply reconnect | `ssh root@159.89.82.167` |
| **Wrong Password** | Reset via DigitalOcean console | Go to droplet dashboard → Reset password |

**Emergency Access:**
1. Go to **DigitalOcean Dashboard**
2. Click your droplet → **Console** 
3. Use web-based terminal access

---

### ⚙️ **Issue #4: Services Not Starting**

**Symptoms:**
- PM2 shows services as "stopped" or "errored"
- Dashboard not accessible
- 502 Bad Gateway error

| Service | Diagnostic | Fix Command |
|---------|------------|-------------|
| **Backend** | `pm2 logs retell-backend` | `pm2 restart retell-backend` |
| **Frontend** | `pm2 logs retell-frontend` | `pm2 restart retell-frontend` |
| **All Services** | `pm2 status` | `pm2 restart all` |

#### **Backend Service Issues** ⚙️
```bash
# Check backend logs
pm2 logs retell-backend

# Common fixes:
cd /root/retell-ai-dashboard/backend

# 1. Missing dependencies
npm install

# 2. Check environment
cat .env  # Should have RETELL_API_KEY, PORT=5000, etc.

# 3. Restart
pm2 restart retell-backend
```

#### **Frontend Service Issues** 🎨
```bash
# Check frontend logs
pm2 logs retell-frontend

# Check build files exist
ls -la /root/retell-ai-dashboard/frontend/build/
# Should contain: index.html, static/ folder, etc.

# If missing, rebuild locally and upload (see Issue #2)
```

#### **Port Conflicts** 🔌
```bash
# Check what's using ports
netstat -tulpn | grep :3000  # Frontend
netstat -tulpn | grep :5000  # Backend
netstat -tulpn | grep :80    # Nginx

# Kill conflicting processes
sudo kill -9 [PID]
pm2 restart all
```

---

### 🌐 **Issue #5: Nginx Configuration Problems**

**Symptoms:**
- 502 Bad Gateway
- Connection refused
- Static files not loading

| Check | Command | Expected Result |
|-------|---------|----------------|
| **Config Syntax** | `sudo nginx -t` | Configuration test successful |
| **Service Status** | `sudo systemctl status nginx` | Active (running) |
| **Error Logs** | `sudo tail -f /var/log/nginx/error.log` | No recent errors |

#### **Configuration Fixes** 🔧
```bash
# Edit nginx configuration
sudo nano /etc/nginx/sites-available/retell-dashboard

# Common issues to check:
# - Missing semicolons
# - Wrong IP addresses (should be 159.89.82.167)
# - Typos in proxy_pass URLs

# Test and restart
sudo nginx -t
sudo systemctl restart nginx
```

#### **Service Recovery** 🔄
```bash
# Start/restart nginx
sudo systemctl start nginx
sudo systemctl enable nginx
sudo systemctl status nginx

# If still failing, check backend services
pm2 status
```

---

### 🔑 **Issue #6: Environment Variable Problems**

**Symptoms:**
- API calls fail
- CORS errors
- Configuration not applied

#### **Check Current Settings** 🔍
| Component | Check Command | What to Look For |
|-----------|---------------|------------------|
| **Backend** | `cd /root/retell-ai-dashboard/backend && cat .env` | RETELL_API_KEY, PORT=5000, CORS_ORIGIN |
| **Frontend** | `cd /root/retell-ai-dashboard/frontend && cat .env` | REACT_APP_API_URL |

#### **Fix Backend Environment** ⚙️
```bash
cd /root/retell-ai-dashboard/backend
cat > .env << EOF
RETELL_API_KEY=key_5286e8b619b00ed6815991eba586
PORT=5000
NODE_ENV=production
CORS_ORIGIN=http://159.89.82.167
EOF

pm2 restart retell-backend
```

#### **Fix Frontend Environment** 🎨
```bash
cd /root/retell-ai-dashboard/frontend
echo "REACT_APP_API_URL=http://159.89.82.167/api" > .env

# ⚠️ Note: Frontend needs rebuild for env changes
# Build locally and upload (see Issue #2)
```

---

### 🐌 **Issue #7: Server Performance Problems**

**Symptoms:**
- Slow dashboard loading
- Timeouts
- High resource usage

#### **Performance Diagnostics** 📊
| Resource | Check Command | Healthy Range |
|----------|---------------|---------------|
| **Memory** | `free -m` | < 80% used |
| **CPU** | `top -bn1 \| grep "Cpu(s)"` | < 70% usage |
| **Disk** | `df -h` | < 80% used |
| **Processes** | `pm2 monit` | Services online, low resource usage |

#### **Performance Fixes** ⚡
```bash
# 1. High Memory Usage
ps aux --sort=-%mem | head -10  # Find memory hogs
pm2 restart all                 # Restart services
sudo sync && sudo echo 3 > /proc/sys/vm/drop_caches  # Clear cache

# 2. High CPU Usage  
top -o %CPU                     # Find CPU hogs
pm2 restart all                 # Often fixes stuck processes

# 3. Disk Space Issues
df -h                           # Check disk usage
pm2 flush                       # Clear old logs
sudo apt autoremove && sudo apt autoclean  # Clean packages
```

---

### 🌐 **Issue #8: API Connection Problems**

**Symptoms:**
- API requests fail
- Blank dashboard
- Network errors in browser console

#### **API Diagnostics** 🔍
| Test | Command | Expected Result |
|------|---------|----------------|
| **Backend Direct** | `curl http://localhost:5000/api/calls` | JSON with call data |
| **Through Nginx** | `curl http://159.89.82.167/api/calls` | Same JSON data |
| **Health Check** | `curl http://159.89.82.167/api/health` | {"status": "ok"} |

#### **API Fixes** 🔧
```bash
# 1. Backend Not Responding
pm2 logs retell-backend         # Check for errors
pm2 restart retell-backend      # Restart service
ps aux | grep node              # Verify process running

# 2. CORS Issues
cd /root/retell-ai-dashboard/backend
grep CORS .env                  # Should be: CORS_ORIGIN=http://159.89.82.167
pm2 restart retell-backend      # Restart after changes

# 3. Retell API Issues
curl -H "Authorization: Bearer key_5286e8b619b00ed6815991eba586" \
     https://api.retellai.com/v2/list-calls  # Test Retell API directly
```

---

## 🚨 Emergency Recovery Procedures

### **Complete System Recovery** 🔄 *(10-15 minutes)*
```bash
# 1. Connect to server
ssh root@159.89.82.167

# 2. Stop all services
pm2 kill
sudo systemctl stop nginx

# 3. Restart everything
sudo systemctl start nginx
cd /root/retell-ai-dashboard/backend
pm2 start server.js --name "retell-backend"
cd ../frontend
pm2 serve build 3000 --name "retell-frontend" --spa
pm2 save

# 4. Verify everything is working
pm2 status
curl http://159.89.82.167/api/health
```

### **Server Unresponsive** 🆘
1. **DigitalOcean Console**: Go to droplet dashboard → Console
2. **Hard Reboot**: Power cycle via DigitalOcean panel
3. **PM2 Auto-Recovery**: Services should restart automatically
4. **Manual Recovery**: Run complete system recovery above

---

## 🔍 Advanced Diagnostics

### **Log Analysis** 📋
| Log Type | Command | Common Issues |
|----------|---------|---------------|
| **Application** | `pm2 logs --lines 50` | API errors, crashes |
| **Nginx Error** | `sudo tail -50 /var/log/nginx/error.log` | Proxy errors, config issues |
| **Nginx Access** | `sudo tail -50 /var/log/nginx/access.log` | Request patterns, status codes |
| **System** | `sudo tail -50 /var/log/syslog` | System-level issues |

### **Network Diagnostics** 🌐
```bash
# Port accessibility
netstat -tulpn | grep -E ":(80|3000|5000)"

# Network connectivity
ping google.com
curl -I https://api.retellai.com

# DNS resolution
nslookup retellai.com
```

### **Process Analysis** ⚙️
```bash
# Find resource-heavy processes
top -o %CPU
top -o %MEM

# Check service dependencies
systemctl list-dependencies nginx
systemctl list-dependencies ssh

# Monitor real-time performance
htop  # Install with: sudo apt install htop
```

---

## 📚 Related Documentation

| Problem Type | See Document |
|--------------|--------------|
| **Initial Setup** | [PRODUCTION_SETUP.md](./PRODUCTION_SETUP.md) |
| **Regular Updates** | [WORKFLOW.md](./WORKFLOW.md) |
| **Quick Commands** | [QUICK_REFERENCE.md](./QUICK_REFERENCE.md) |
| **Deployment Options** | [DEPLOYMENT.md](./DEPLOYMENT.md) |

---

## 🎯 Prevention Tips

### **Daily Monitoring** ✅
- Run `pm2 status` daily
- Check `df -h` for disk space weekly
- Monitor logs: `pm2 logs --lines 10`
- Test dashboard: [http://159.89.82.167](http://159.89.82.167)

### **Best Practices** 📋
- ✅ Always build React locally (never on 1GB server)
- ✅ Set correct environment variables
- ✅ Test locally before deploying
- ✅ Use `pm2 save` after configuration changes
- ✅ Keep system packages updated monthly

---

**🌐 Production Dashboard**: [http://159.89.82.167](http://159.89.82.167)  
**🔑 Server Access**: `ssh root@159.89.82.167`  
**📅 Last Updated**: July 10, 2025  
**✅ Status**: Production Ready 