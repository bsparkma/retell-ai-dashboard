# Quick Reference - Retell AI Dashboard

**⚡ Instant access to essential commands and information for production operations.**

## 🚀 Production Status

| Component | Details |
|-----------|---------|
| **🌐 Dashboard** | [http://159.89.82.167](http://159.89.82.167) |
| **🖥️ Server** | DigitalOcean Droplet (Ubuntu 20.04, 1GB RAM) |
| **📂 Repository** | [bsparkma/retell-ai-dashboard](https://github.com/bsparkma/retell-ai-dashboard) |
| **🔑 Access** | `ssh root@159.89.82.167` |

---

## 🔧 Essential Commands

### Server Access & Status
| Command | Purpose |
|---------|---------|
| `ssh root@159.89.82.167` | Connect to production server |
| `pm2 status` | Check all service status |
| `sudo systemctl status nginx` | Check web server status |
| `pm2 monit` | Real-time monitoring dashboard |

### Service Management
| Command | Purpose |
|---------|---------|
| `pm2 restart retell-backend` | Restart backend service |
| `pm2 restart retell-frontend` | Restart frontend service |
| `pm2 restart all` | Restart all services |
| `pm2 stop all` | Stop all services |
| `pm2 start all` | Start all services |

### Logs & Debugging
| Command | Purpose |
|---------|---------|
| `pm2 logs` | View all application logs |
| `pm2 logs retell-backend` | Backend logs only |
| `pm2 logs retell-frontend` | Frontend logs only |
| `pm2 logs --lines 50` | Show last 50 log lines |
| `pm2 flush` | Clear all logs |

### Health Checks
| Command | Purpose |
|---------|---------|
| `curl http://159.89.82.167/api/health` | Test API health |
| `curl http://localhost:5000/api/calls` | Test backend directly |
| `curl -I http://159.89.82.167` | Check frontend response |
| `netstat -tulpn \| grep :80` | Check port 80 usage |

---

## 🚀 Quick Deployment Methods

### **Method 1: Frontend-Only Update** ⚡ *(5-10 min)*
```bash
# 🖥️ On local machine
cd frontend
$env:REACT_APP_API_URL="http://159.89.82.167/api"
npm run build
scp -r build\* root@159.89.82.167:/root/retell-ai-dashboard/frontend/build/

# 🌐 On server
ssh root@159.89.82.167 "pm2 restart retell-frontend"
```

### **Method 2: Full Update** 🔄 *(10-15 min)*
```bash
# 🖥️ Local: Commit and push
git add . && git commit -m "Your changes" && git push origin main

# 🌐 Server: Update and restart
ssh root@159.89.82.167
cd /root/retell-ai-dashboard
git pull origin main
pm2 restart all
```

### **Method 3: Backend-Only Update** ⚙️ *(5 min)*
```bash
ssh root@159.89.82.167
cd /root/retell-ai-dashboard
git pull origin main
pm2 restart retell-backend
```

---

## 🚨 Emergency Recovery

### **Quick Service Recovery**
```bash
# Connect to server
ssh root@159.89.82.167

# Restart everything
pm2 restart all
sudo systemctl restart nginx

# Verify status
pm2 status
```

### **Complete Service Reset**
```bash
# Stop all services
pm2 kill

# Restart backend
cd /root/retell-ai-dashboard/backend
pm2 start server.js --name "retell-backend"

# Restart frontend  
cd ../frontend
pm2 serve build 3000 --name "retell-frontend" --spa

# Save configuration
pm2 save
```

### **If Server is Unresponsive**
1. Use **DigitalOcean Console** (web-based terminal)
2. Go to your droplet dashboard
3. Click "Console" to access server directly
4. Run recovery commands above

---

## 📁 Important File Locations

### **Configuration Files**
| File | Location |
|------|----------|
| **Backend .env** | `/root/retell-ai-dashboard/backend/.env` |
| **Frontend .env** | `/root/retell-ai-dashboard/frontend/.env` |
| **Nginx Config** | `/etc/nginx/sites-available/retell-dashboard` |
| **PM2 Config** | View with `pm2 status` |

### **Application Directories**
| Directory | Purpose |
|-----------|---------|
| `/root/retell-ai-dashboard/` | Main application directory |
| `/root/retell-ai-dashboard/backend/` | Backend Node.js app |
| `/root/retell-ai-dashboard/frontend/build/` | Frontend build files |

### **Log Locations**
| Log Type | Location |
|----------|----------|
| **PM2 Logs** | `pm2 logs` (dynamic) |
| **Nginx Error** | `/var/log/nginx/error.log` |
| **Nginx Access** | `/var/log/nginx/access.log` |
| **System Logs** | `/var/log/syslog` |

---

## 🔍 Troubleshooting Quick Fixes

### **Dashboard Shows Mock Data**
```bash
cd /root/retell-ai-dashboard/frontend
echo "REACT_APP_API_URL=http://159.89.82.167/api" > .env
pm2 restart retell-frontend
```

### **API Not Responding**
```bash
cd /root/retell-ai-dashboard/backend
cat .env  # Verify RETELL_API_KEY exists
pm2 logs retell-backend  # Check for errors
pm2 restart retell-backend
```

### **Build Failed Error**
```bash
# ⚠️ NEVER build on server (1GB RAM limit)
# Always build locally and upload:

# 1. 🖥️ Local build
cd frontend && npm run build

# 2. 📤 Upload to server  
scp -r build\* root@159.89.82.167:/root/retell-ai-dashboard/frontend/build/

# 3. 🔄 Restart service
ssh root@159.89.82.167 "pm2 restart retell-frontend"
```

### **Services Won't Start**
```bash
# Check what's using ports
netstat -tulpn | grep :3000  # Frontend port
netstat -tulpn | grep :5000  # Backend port
netstat -tulpn | grep :80    # Nginx port

# Kill conflicting processes if needed
sudo kill -9 [PID]
```

---

## 📊 System Monitoring

### **Resource Monitoring**
| Command | Purpose |
|---------|---------|
| `top` | Real-time CPU/Memory usage |
| `htop` | Enhanced process viewer |
| `free -m` | Memory usage in MB |
| `df -h` | Disk space usage |
| `du -sh *` | Directory sizes |

### **Network Monitoring**
| Command | Purpose |
|---------|---------|
| `netstat -tulpn` | All port usage |
| `ss -tulpn` | Modern netstat alternative |
| `iotop` | Disk I/O monitoring |
| `nload` | Network bandwidth usage |

### **Performance Checks**
```bash
# CPU usage
top -bn1 | grep "Cpu(s)"

# Memory usage  
free -m | grep Mem

# Disk usage
df -h | grep -v tmpfs

# Network connections
netstat -an | grep :80 | wc -l
```

---

## ⚙️ Environment Variables Reference

### **Production Backend (.env)**
```bash
RETELL_API_KEY=key_5286e8b619b00ed6815991eba586
PORT=5000
NODE_ENV=production
CORS_ORIGIN=http://159.89.82.167
```

### **Production Frontend (.env)**
```bash
REACT_APP_API_URL=http://159.89.82.167/api
```

### **Local Development**
```bash
# Backend
RETELL_API_KEY=your_key_here
PORT=5000
NODE_ENV=development

# Frontend  
REACT_APP_API_URL=http://localhost:5000/api
```

---

## 📚 Documentation Navigation

| Document | Purpose | Use When |
|----------|---------|----------|
| **📖 [README.md](./README.md)** | Project overview | Getting started |
| **🚀 [DEPLOYMENT.md](./DEPLOYMENT.md)** | Complete deployment guide | Setting up new servers |
| **🔧 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)** | Detailed issue resolution | Something's broken |
| **🔄 [WORKFLOW.md](./WORKFLOW.md)** | Development process | Making updates |
| **🏗️ [PRODUCTION_SETUP.md](./PRODUCTION_SETUP.md)** | Step-by-step setup | Initial deployment |

---

**🌐 Production Dashboard**: [http://159.89.82.167](http://159.89.82.167)  
**📅 Last Updated**: July 10, 2025  
**✅ Status**: Production Ready 