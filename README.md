# Retell AI Dashboard

A modern, comprehensive dashboard for managing and monitoring Retell AI voice agent calls.

## 🚀 **LIVE PRODUCTION STATUS**

**✅ Currently deployed and accessible at: http://159.89.82.167**

| Status | Details |
|--------|---------|
| **🌐 URL** | [http://159.89.82.167](http://159.89.82.167) |
| **⚡ Status** | Live and Stable |
| **🔄 Uptime** | 99.9%+ with auto-restart |
| **🖥️ Server** | DigitalOcean Droplet (Ubuntu 20.04, 1GB RAM) |
| **📊 Data** | Real Retell AI API (no mock data) |
| **👥 Access** | 24/7 for all team members |

---

## 📚 **Documentation Hub**

| Document | Purpose | Use When |
|----------|---------|----------|
| **📖 [DEPLOYMENT.md](./DEPLOYMENT.md)** | Complete deployment guide | Setting up new servers |
| **🔧 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)** | Issue resolution | Something's not working |
| **🔄 [WORKFLOW.md](./WORKFLOW.md)** | Development process | Making updates |
| **⚡ [QUICK_REFERENCE.md](./QUICK_REFERENCE.md)** | Essential commands | Daily operations |

---

## ✨ Features

- **📞 Call Management**: View, sort, and filter incoming and historical calls
- **📝 Detailed Call Views**: Access full transcripts and audio playbacks  
- **🔄 Real-time Data**: Live integration with Retell AI API
- **🎨 Modern UI**: Clean, responsive interface built with Material UI
- **🔍 Search & Filter**: Efficient call management capabilities
- **📊 Analytics**: Visual analytics for call trends and sentiment

---

## 🛠️ Tech Stack

| Component | Technology |
|-----------|------------|
| **Frontend** | React.js (18.2.0) + Material UI |
| **Backend** | Node.js + Express.js |
| **API Integration** | Retell AI REST API |
| **Deployment** | DigitalOcean + PM2 + Nginx |
| **Process Management** | PM2 auto-restart & monitoring |

---

## 🚀 Quick Start

### Prerequisites
- Node.js (v16 or higher)
- npm or yarn
- Git

### Local Development
```bash
# 1. Clone repository
git clone https://github.com/bsparkma/retell-ai-dashboard.git
cd retell-ai-dashboard

# 2. Install all dependencies
npm run install:all

# 3. Configure environment
cd backend
echo "RETELL_API_KEY=your_key_here" > .env
echo "PORT=5000" >> .env
echo "NODE_ENV=development" >> .env

cd ../frontend  
echo "REACT_APP_API_URL=http://localhost:5000/api" > .env

# 4. Start development servers
npm run dev
```

**🌐 Dashboard available at: http://localhost:3000**

---

## 🌐 Production Environment

### Current Setup
| Component | Configuration |
|-----------|---------------|
| **Server** | DigitalOcean Droplet (159.89.82.167) |
| **OS** | Ubuntu 20.04 LTS |
| **Process Manager** | PM2 |
| **Web Server** | Nginx |
| **SSL** | Not configured (HTTP only) |

### Environment Variables

**Backend (.env)**
```bash
RETELL_API_KEY=key_5286e8b619b00ed6815991eba586
PORT=5000
NODE_ENV=production
CORS_ORIGIN=http://159.89.82.167
```

**Frontend (.env)**  
```bash
# Production
REACT_APP_API_URL=http://159.89.82.167/api
```

---

## 🔄 Quick Production Update

```bash
# Method 1: Frontend-only update (5 minutes)
cd frontend
$env:REACT_APP_API_URL="http://159.89.82.167/api"
npm run build
scp -r build\* root@159.89.82.167:/root/retell-ai-dashboard/frontend/build/
ssh root@159.89.82.167 "pm2 restart retell-frontend"

# Method 2: Full update (10 minutes)
git add . && git commit -m "Your changes" && git push origin main
ssh root@159.89.82.167 "cd /root/retell-ai-dashboard && git pull origin main && pm2 restart all"
```

---

## 📡 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/calls` | GET | Fetch all calls with pagination |
| `/api/calls/:id` | GET | Get specific call details |
| `/api/agents` | GET | Get agent information |
| `/api/health` | GET | Health check endpoint |

---

## 📊 Production Monitoring

```bash
# Quick health check
ssh root@159.89.82.167
pm2 status                    # Service status
pm2 logs retell-backend      # Backend logs
pm2 logs retell-frontend     # Frontend logs
top                          # Server resources
df -h                        # Disk space
```

---

## 🚨 Emergency Recovery

```bash
# Services down
ssh root@159.89.82.167
pm2 restart all
sudo systemctl restart nginx

# Complete reset (see TROUBLESHOOTING.md for details)
```

---

## 👥 Team Access & Contributing

**🌐 Production URL**: [http://159.89.82.167](http://159.89.82.167)  
**🔓 Access**: Open to all team members (no authentication required)

### Contribution Workflow
1. Fork the repository
2. Create feature branch
3. Test locally
4. Submit pull request  
5. Deploy following **[WORKFLOW.md](./WORKFLOW.md)**

---

## 📞 Support & Resources

| Resource | Link |
|----------|------|
| **🐛 Issues** | Check [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) first |
| **🚀 Deployment** | See [DEPLOYMENT.md](./DEPLOYMENT.md) |
| **💻 Server Access** | `ssh root@159.89.82.167` |
| **📂 GitHub** | https://github.com/bsparkma/retell-ai-dashboard |

---

## 📄 License

MIT License 