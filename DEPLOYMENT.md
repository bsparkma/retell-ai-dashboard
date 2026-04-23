# Deployment Guide - Retell AI Dashboard

**Complete deployment reference for Retell AI Dashboard across multiple platforms.**

## 🚀 Current Production Status

**✅ Live at: [http://159.89.82.167](http://159.89.82.167)**

| Component | Status |
|-----------|--------|
| **🌐 Platform** | DigitalOcean Droplet |
| **🖥️ Server** | Ubuntu 20.04 LTS (1 vCPU, 1GB RAM) |
| **📊 Data** | Live Retell AI API connection |
| **⚡ Uptime** | 99.9%+ with PM2 auto-restart |
| **🔄 Status** | ✅ Production ready |

---

## 📋 Prerequisites

- Node.js (v16 or higher)
- npm or yarn
- Git
- Your Retell AI API key
- SSH client (for server deployment)

---

## 🎯 Deployment Options

### 🌊 **DigitalOcean (Recommended - Currently in Production)**

**✅ Proven in production with our exact setup**

**Quick Setup:**
- **Time**: 45-60 minutes
- **Cost**: $6/month
- **Difficulty**: Beginner-friendly

**📖 [Follow PRODUCTION_SETUP.md](./PRODUCTION_SETUP.md)** for complete step-by-step guide.

**Key Benefits:**
- ✅ Tested and proven to work
- ✅ Complete documentation with all gotchas solved
- ✅ $6/month basic droplet sufficient
- ✅ PM2 + Nginx production-ready setup

---

### 🚂 Railway (Cloud Platform)

**Good for:** Quick deployments, automatic scaling

**Backend Setup:**
1. Connect GitHub repo to Railway
2. Set root directory to `backend`
3. Environment variables:
   ```
   RETELL_API_KEY=your_key
   PORT=5000
   NODE_ENV=production
   ```

**Frontend Setup:**
1. Create new Railway service
2. Set root directory to `frontend`  
3. Environment variable:
   ```
   REACT_APP_API_URL=https://your-backend.railway.app/api
   ```

**Limitations:**
- Limited free tier
- Can be more expensive at scale

---

### ▲ Vercel + Render

**Good for:** Frontend on Vercel, backend on Render

**Frontend (Vercel):**
1. Import GitHub repo to Vercel
2. Set root directory to `frontend`
3. Environment variable: `REACT_APP_API_URL=https://your-backend.onrender.com/api`

**Backend (Render):**
1. Connect GitHub repo to Render
2. Set root directory to `backend`
3. Environment variables: `RETELL_API_KEY`, `PORT=5000`

**Note:** Free tiers have limitations and cold start delays.

---

### 🐳 Docker Deployment

**Good for:** Containerized environments, consistent deploys

```bash
# Uses included docker-compose.yml
docker-compose up -d
```

**Requirements:**
- Docker & Docker Compose installed
- Configure environment variables in docker-compose.yml

---

## ⚙️ Environment Configuration

### Production Environment Variables

**Backend (.env):**
```bash
RETELL_API_KEY=<your-retell-api-key>
PORT=5000
NODE_ENV=production
CORS_ORIGIN=http://159.89.82.167
```

**Frontend (.env):**
```bash
REACT_APP_API_URL=http://159.89.82.167/api
```

### Local Development
```bash
# Backend
RETELL_API_KEY=your_key
PORT=5000
NODE_ENV=development

# Frontend
REACT_APP_API_URL=http://localhost:5000/api
```

---

## 🔄 Deployment Workflow

### Initial Deployment
1. **📖 [PRODUCTION_SETUP.md](./PRODUCTION_SETUP.md)** - Complete DigitalOcean setup
2. **🔧 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)** - If issues arise

### Regular Updates  
1. **🔄 [WORKFLOW.md](./WORKFLOW.md)** - Development to production workflow
2. **⚡ [QUICK_REFERENCE.md](./QUICK_REFERENCE.md)** - Essential commands

---

## ⚠️ Critical Notes

### 🔴 **Memory Limitation (1GB Servers)**
**React builds require 2GB+ RAM. Always build locally:**

```powershell
# Local build (Windows)
cd frontend
$env:REACT_APP_API_URL="http://YOUR_IP/api"
npm run build
scp -r build\* root@YOUR_IP:/path/to/frontend/build/
```

### 🔴 **Frontend Environment Variables**
**Must set REACT_APP_API_URL or dashboard shows mock data:**

```bash
# On server
cd /root/retell-ai-dashboard/frontend
echo "REACT_APP_API_URL=http://YOUR_IP/api" > .env
pm2 restart retell-frontend
```

---

## 🛠️ Monitoring & Maintenance

### Health Checks
```bash
# Service status
ssh root@159.89.82.167
pm2 status

# API test
curl http://159.89.82.167/api/health
curl http://159.89.82.167/api/calls
```

### Log Monitoring
```bash
# Application logs
pm2 logs retell-backend
pm2 logs retell-frontend

# System logs  
sudo tail -f /var/log/nginx/error.log
```

### Resource Monitoring
```bash
# Server resources
top           # CPU/Memory
df -h         # Disk space
free -m       # Memory details
```

---

## 🔐 Security Considerations

### Current Setup
- Basic server security (Ubuntu 20.04 LTS)
- CORS protection configured
- Rate limiting on API endpoints
- Helmet.js security headers

### Recommended Improvements
1. **🔒 SSL Certificate**: Add HTTPS with Let's Encrypt
2. **🔥 Firewall**: Configure UFW for port restrictions  
3. **🔐 Authentication**: Add team authentication system
4. **📊 Monitoring**: Set up uptime monitoring alerts
5. **💾 Backups**: Regular DigitalOcean snapshots

---

## 📞 Support Resources

| Resource | Link |
|----------|------|
| **🌐 Production URL** | [http://159.89.82.167](http://159.89.82.167) |
| **🖥️ Server Access** | `ssh root@159.89.82.167` |
| **📂 GitHub Repository** | https://github.com/bsparkma/retell-ai-dashboard |
| **🔧 Troubleshooting** | [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) |
| **⚡ Quick Commands** | [QUICK_REFERENCE.md](./QUICK_REFERENCE.md) |

---

**📅 Last Updated**: July 10, 2025  
**✅ Status**: Production Ready 