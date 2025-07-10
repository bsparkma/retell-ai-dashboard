# Development Workflow - Retell AI Dashboard

**Complete guide for developing, testing, and deploying updates to your production Retell AI Dashboard.**

## 🎯 Overview

This document outlines the proven workflow for making changes to your Retell AI Dashboard and deploying them to production safely.

| Environment | Details |
|-------------|---------|
| **🌐 Production** | [http://159.89.82.167](http://159.89.82.167) |
| **🖥️ Server** | DigitalOcean Droplet (Ubuntu 20.04) |
| **📂 Repository** | [bsparkma/retell-ai-dashboard](https://github.com/bsparkma/retell-ai-dashboard) |

---

## 🛠️ Local Development Setup

### Initial Setup (One-time)
```bash
# 1. Clone repository
git clone https://github.com/bsparkma/retell-ai-dashboard.git
cd retell-ai-dashboard

# 2. Install all dependencies
npm run install:all

# 3. Configure backend environment
cd backend
echo "RETELL_API_KEY=key_5286e8b619b00ed6815991eba586" > .env
echo "PORT=5000" >> .env
echo "NODE_ENV=development" >> .env

# 4. Configure frontend environment
cd ../frontend
echo "REACT_APP_API_URL=http://localhost:5000/api" > .env
```

### Start Development
```bash
# Start both frontend and backend
npm run dev

# This starts:
# 🎨 Frontend: http://localhost:3000
# ⚙️ Backend: http://localhost:5000
```

---

## 🔄 Development Workflow

### 1. **Make Changes Locally**

**✅ Best Practices:**
- Always test locally first
- Make small, focused changes
- Test with real Retell data
- Verify both frontend and backend
- Check responsive design
- Test in multiple browsers

### 2. **Testing Checklist**
- [ ] Dashboard loads without errors
- [ ] Real call data displays correctly
- [ ] All features work as expected
- [ ] No console errors
- [ ] Mobile/tablet responsive
- [ ] API endpoints respond correctly

### 3. **Commit Changes**
```bash
# Stage and commit changes
git add .
git commit -m "Clear description of changes"
git push origin main
```

---

## 🚀 Production Deployment

### **Method 1: Frontend-Only Updates** ⚡ **(5-10 minutes)**

**Use when:** UI changes, styling, frontend logic

```bash
# 1. Build with production settings
cd frontend
$env:REACT_APP_API_URL="http://159.89.82.167/api"
npm run build

# 2. Upload to server
scp -r build\* root@159.89.82.167:/root/retell-ai-dashboard/frontend/build/

# 3. Restart frontend service
ssh root@159.89.82.167 "pm2 restart retell-frontend"
```

### **Method 2: Full Application Update** 🔄 **(10-15 minutes)**

**Use when:** Backend changes, dependencies, full updates

```bash
# 1. Commit and push changes
git add .
git commit -m "Your descriptive message"
git push origin main

# 2. Update server
ssh root@159.89.82.167
cd /root/retell-ai-dashboard
git pull origin main
pm2 restart all
```

### **Method 3: Backend-Only Updates** ⚙️ **(5 minutes)**

**Use when:** API changes, environment updates

```bash
# Update code and restart backend
ssh root@159.89.82.167
cd /root/retell-ai-dashboard
git pull origin main
pm2 restart retell-backend
```

---

## 📋 Deployment Checklist

### **Pre-Deployment** ✅
- [ ] Changes tested locally
- [ ] Real data displays correctly  
- [ ] No console errors in browser
- [ ] Code committed to GitHub
- [ ] Choose appropriate deployment method

### **Post-Deployment** ✅
- [ ] Dashboard loads: [http://159.89.82.167](http://159.89.82.167)
- [ ] All features working
- [ ] No browser console errors
- [ ] API endpoints responding
- [ ] Services running: `pm2 status`

---

## 📊 Daily Monitoring

### **Quick Health Check**
```bash
# Connect and check status
ssh root@159.89.82.167
pm2 status

# Test API endpoint
curl http://159.89.82.167/api/health

# Quick dashboard test
curl -I http://159.89.82.167
```

### **Detailed Monitoring**
```bash
# View application logs
pm2 logs
pm2 logs retell-backend
pm2 logs retell-frontend

# Check server resources
top          # CPU/Memory usage
df -h        # Disk space
free -m      # Memory details
```

---

## 🚨 Emergency Procedures

### **Services Down**
```bash
ssh root@159.89.82.167

# Quick restart all services
pm2 restart all
sudo systemctl restart nginx

# Check status
pm2 status
sudo systemctl status nginx
```

### **Dashboard Not Loading**
```bash
# 1. Check services
pm2 status

# 2. Check logs
pm2 logs

# 3. Restart individual services
pm2 restart retell-frontend
pm2 restart retell-backend

# 4. If still failing, see troubleshooting
```

**🔧 For detailed issue resolution: [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)**

---

## 🎯 Development Tips

### **Efficient Development**
- Use `npm run dev` for hot reloading
- Test API endpoints with Postman or curl
- Use browser dev tools for debugging
- Check both Network and Console tabs

### **Common Gotchas**
- ⚠️ Always build locally (server has limited memory)
- ⚠️ Set correct REACT_APP_API_URL for production
- ⚠️ Test with real Retell API data
- ⚠️ Verify CORS settings for production

### **Performance Tips**
- Frontend-only updates are fastest (5 min)
- Use `pm2 logs` to debug issues quickly
- Monitor server resources: `top` and `df -h`
- Keep dependencies updated regularly

---

## 📚 Related Documentation

| Document | Use Case |
|----------|----------|
| **📖 [DEPLOYMENT.md](./DEPLOYMENT.md)** | Setting up new environments |
| **🔧 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)** | When something breaks |
| **⚡ [QUICK_REFERENCE.md](./QUICK_REFERENCE.md)** | Daily operation commands |
| **🚀 [PRODUCTION_SETUP.md](./PRODUCTION_SETUP.md)** | Initial server setup |

---

**🌐 Production URL**: [http://159.89.82.167](http://159.89.82.167)  
**📅 Last Updated**: July 10, 2025  
**✅ Status**: Production Ready 