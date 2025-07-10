# Production Setup Guide - DigitalOcean Deployment

**Complete step-by-step guide for deploying Retell AI Dashboard to DigitalOcean**

## 🎯 Overview

This document provides the exact steps we used to successfully deploy our Retell AI Dashboard to production on DigitalOcean. Follow this guide to replicate our setup.

**Current Production Status:**
- **URL**: http://159.89.82.167
- **Server**: DigitalOcean Basic Droplet ($6/month)
- **Stack**: Ubuntu 20.04 + Node.js + PM2 + Nginx
- **Status**: ✅ Live and stable

---

## 📋 Prerequisites

Before starting, ensure you have:

- [ ] DigitalOcean account
- [ ] GitHub repository with your code
- [ ] Retell AI API key
- [ ] SSH client (PuTTY on Windows, or terminal)
- [ ] Local development environment working

---

## Step 1: Create DigitalOcean Droplet

### 1.1 Account Setup
1. Go to [cloud.digitalocean.com](https://cloud.digitalocean.com)
2. Sign up or log into your account
3. Complete billing setup (you'll need a payment method)

### 1.2 Create Droplet
1. **Click "Create" → "Droplets"**
2. **Choose Image**: 
   - Select "Ubuntu"
   - Choose "20.04 (LTS) x64"
3. **Choose Plan**:
   - Select "Basic"
   - Choose "$6/mo" option (1 vCPU, 1 GB Memory, 25 GB SSD)
4. **Choose Region**:
   - Select closest to your team (we used NYC1)
5. **Authentication**:
   - Select "Password"
   - Create a strong password (save this!)
6. **Finalize Details**:
   - Hostname: `retell-dashboard`
   - Tags: `retell`, `production` (optional)
7. **Click "Create Droplet"**

### 1.3 Note Your IP Address
- Once created, copy the IP address (e.g., `159.89.82.167`)
- This will be your production URL

---

## Step 2: Initial Server Setup

### 2.1 Connect via SSH
```bash
# Replace with your actual IP
ssh root@159.89.82.167
```
Enter the password you created when prompted.

### 2.2 Update System
```bash
# Update package list and upgrade system
sudo apt update && sudo apt upgrade -y

# This may take 5-10 minutes
# You may see configuration prompts - choose option 1 (install maintainer's version)
```

### 2.3 Install Node.js
```bash
# Install Node.js 18.x (latest stable)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installation
node --version
npm --version
```

### 2.4 Install PM2 Process Manager
```bash
# Install PM2 globally
sudo npm install -g pm2

# Verify installation
pm2 --version
```

### 2.5 Install Nginx Web Server
```bash
# Install Nginx
sudo apt install nginx -y

# Start and enable Nginx
sudo systemctl start nginx
sudo systemctl enable nginx

# Verify it's running
sudo systemctl status nginx
```

---

## Step 3: Deploy Your Application

### 3.1 Clone Repository
```bash
# Clone your GitHub repository
git clone https://github.com/bsparkma/retell-ai-dashboard.git
cd retell-ai-dashboard

# Verify contents
ls -la
```

### 3.2 Install Dependencies
```bash
# Install all dependencies (this may take 3-5 minutes)
npm run install:all

# Verify backend dependencies
cd backend && ls node_modules
cd ../frontend && ls node_modules
cd ..
```

### 3.3 Configure Backend Environment
```bash
cd backend

# Create environment file
echo "RETELL_API_KEY=key_5286e8b619b00ed6815991eba586" > .env
echo "PORT=5000" >> .env
echo "NODE_ENV=production" >> .env
echo "CORS_ORIGIN=http://159.89.82.167" >> .env

# Verify configuration
cat .env
```

### 3.4 Start Backend Service
```bash
# Start backend with PM2
pm2 start server.js --name "retell-backend"

# Verify it's running
pm2 status

# Check logs
pm2 logs retell-backend --lines 10
```

---

## Step 4: Frontend Deployment

### 4.1 ⚠️ CRITICAL: Build Locally
**The 1GB server cannot build React apps. You MUST build on your local machine.**

**On your local Windows machine:**
```powershell
# Navigate to your project
cd "C:\Users\beau\carein cursor dashboard\frontend"

# Set production API URL (replace with your IP)
$env:REACT_APP_API_URL="http://159.89.82.167/api"

# Build the project
npm run build

# Verify build succeeded
ls build
```

### 4.2 Upload Build to Server
```powershell
# Still on local machine - upload build files
scp -r build\* root@159.89.82.167:/root/retell-ai-dashboard/frontend/build/
```

### 4.3 Start Frontend Service
**Back on your server (SSH session):**
```bash
cd /root/retell-ai-dashboard/frontend

# Verify build files exist
ls -la build/

# Start frontend with PM2
pm2 serve build 3000 --name "retell-frontend" --spa

# Verify both services running
pm2 status
```

---

## Step 5: Configure Nginx

### 5.1 Create Nginx Configuration
```bash
# Create new site configuration
sudo nano /etc/nginx/sites-available/retell-dashboard
```

### 5.2 Add Configuration
**Copy and paste this exactly (replace IP with yours):**
```nginx
server {
    listen 80;
    server_name 159.89.82.167;
    
    # Frontend
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    
    # Backend API
    location /api/ {
        proxy_pass http://localhost:5000/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**Save and exit:**
- Press `Ctrl + O` to save
- Press `Enter` to confirm
- Press `Ctrl + X` to exit

### 5.3 Enable the Site
```bash
# Enable the new site
sudo ln -s /etc/nginx/sites-available/retell-dashboard /etc/nginx/sites-enabled/

# Remove default site
sudo rm /etc/nginx/sites-enabled/default

# Test configuration
sudo nginx -t

# If test passes, restart Nginx
sudo systemctl restart nginx
sudo systemctl enable nginx
```

---

## Step 6: Configure Auto-Restart

### 6.1 Save PM2 Configuration
```bash
# Save current PM2 processes
pm2 save

# Setup PM2 to start on boot
pm2 startup

# Follow the command shown in output (it will look like):
# sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u root --hp /root
```

### 6.2 Verify Auto-Restart Works
```bash
# Restart server to test auto-restart
sudo reboot

# Wait 2-3 minutes, then reconnect
ssh root@159.89.82.167

# Check services started automatically
pm2 status
```

---

## Step 7: Verification & Testing

### 7.1 Test Dashboard
1. **Open browser** and go to `http://159.89.82.167`
2. **Verify dashboard loads** with real Retell data
3. **Check navigation** - click through different pages

### 7.2 Test API Endpoints
```bash
# Test backend API directly
curl http://localhost:5000/api/calls

# Test through Nginx
curl http://159.89.82.167/api/calls

# Both should return JSON data with real calls
```

### 7.3 Monitor Services
```bash
# Check PM2 status
pm2 status

# Check Nginx status
sudo systemctl status nginx

# Check server resources
top
df -h
free -m
```

---

## Step 8: Team Access Setup

### 8.1 Share with Team
**Send your team this information:**
- **Dashboard URL**: http://159.89.82.167
- **Purpose**: Retell AI call monitoring and analytics
- **Access**: 24/7 availability, no login required

### 8.2 Bookmark Important URLs
- **Dashboard**: http://159.89.82.167
- **API Health**: http://159.89.82.167/api/health
- **Server SSH**: `ssh root@159.89.82.167`

---

## 🔧 Post-Deployment Configuration

### Environment Variables Summary
**Backend (.env):**
```
RETELL_API_KEY=key_5286e8b619b00ed6815991eba586
PORT=5000
NODE_ENV=production
CORS_ORIGIN=http://159.89.82.167
```

**Frontend (.env):**
```
REACT_APP_API_URL=http://159.89.82.167/api
```

### Service Management Commands
```bash
# View all services
pm2 status

# Restart services
pm2 restart retell-backend
pm2 restart retell-frontend
pm2 restart all

# View logs
pm2 logs
pm2 logs retell-backend
pm2 logs retell-frontend

# Stop services (not recommended)
pm2 stop retell-backend
pm2 stop retell-frontend
```

---

## ⚠️ Common Issues During Setup

### Issue: React Build Fails on Server
**Symptoms**: `npm run build` fails with memory error
**Solution**: Always build locally and upload (Step 4.1-4.2)

### Issue: "Command not found" Errors
**Symptoms**: Commands like `node` or `pm2` not found
**Solution**: 
```bash
# Reload shell
source ~/.bashrc

# Or log out and back in
exit
ssh root@159.89.82.167
```

### Issue: Nginx Configuration Errors
**Symptoms**: `nginx -t` fails
**Solution**: 
```bash
# Check syntax carefully
sudo nano /etc/nginx/sites-available/retell-dashboard

# Common issues:
# - Missing semicolons
# - Wrong IP address
# - Typos in location blocks
```

### Issue: Frontend Shows Mock Data
**Symptoms**: Dashboard shows fake data
**Solution**: 
```bash
# Check frontend environment
cd /root/retell-ai-dashboard/frontend
cat .env

# Should show: REACT_APP_API_URL=http://159.89.82.167/api
# If missing, recreate and restart
echo "REACT_APP_API_URL=http://159.89.82.167/api" > .env
pm2 restart retell-frontend
```

---

## 📊 Success Checklist

After following this guide, you should have:

- [ ] DigitalOcean droplet running Ubuntu 20.04
- [ ] Node.js 18.x installed
- [ ] PM2 process manager installed and configured
- [ ] Nginx web server configured and running
- [ ] Backend service running on port 5000
- [ ] Frontend service running on port 3000
- [ ] Dashboard accessible at http://YOUR_IP
- [ ] Real Retell AI data displaying (not mock data)
- [ ] Auto-restart configured for server reboots
- [ ] Team access confirmed and working

---

## 📞 Support Information

**Production Details:**
- **Server IP**: 159.89.82.167
- **Dashboard URL**: http://159.89.82.167
- **SSH Access**: `ssh root@159.89.82.167`
- **GitHub Repo**: https://github.com/bsparkma/retell-ai-dashboard

**Total Setup Time**: ~45-60 minutes for complete deployment

**Monthly Cost**: $6/month DigitalOcean droplet

**Next Steps**: See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for ongoing maintenance and [WORKFLOW.md](./WORKFLOW.md) for development updates.

---

**Last Updated**: July 10, 2025  
**Setup Status**: ✅ Tested and Working 