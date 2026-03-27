# Developer Guide - Retell AI Dashboard

**Comprehensive guide for development, testing, and production deployment**

## 🎯 Overview

This guide documents the complete workflow for developing, testing, and deploying the Retell AI Dashboard based on real-world experience and lessons learned. It covers local development, production deployment, agent filtering configuration, and troubleshooting.

---

## 📋 Prerequisites

### Required Software
- **Node.js** v18+ (confirmed working)
- **npm** (comes with Node.js)
- **Git** for version control
- **SSH client** for production deployment
- **PowerShell** (Windows) or Terminal (Mac/Linux)

### Required Accounts & Access
- **Retell AI API Key** 
- **DigitalOcean account** (for production server)
- **GitHub repository access**
- **Production server SSH access**

---

## 🛠️ Local Development Setup

### Initial Setup

```powershell
# 1. Clone repository
git clone https://github.com/bsparkma/retell-ai-dashboard.git
cd retell-ai-dashboard

# 2. Install all dependencies
npm run install:all

# 3. Configure backend environment
cd backend
echo "RETELL_API_KEY=your_key_here" > .env
echo "PORT=5000" >> .env
echo "NODE_ENV=development" >> .env
echo "CORS_ORIGIN=http://localhost:3000" >> .env

# 4. Configure frontend environment  
cd ../frontend
echo "REACT_APP_API_URL=http://localhost:5000/api" > .env

# 5. Return to root
cd ..
```

### Development Workflow

**🚨 CRITICAL: Always use `npm run dev` for local development**

```powershell
# Start both frontend and backend together
npm run dev
```

**❌ DO NOT use individual `npm start` commands:**
- Root `npm start` only starts backend
- Frontend `npm start` without backend running causes API errors
- `npm run dev` uses concurrency to start both properly

### Port Management

**⚠️ Common Port Conflicts:**
- **Port 3000**: Often occupied by Grafana or other services
- **Port 5000**: Can conflict with Windows services

**Resolution Strategy:**
```powershell
# Check what's running on ports
netstat -ano | findstr :3000
netstat -ano | findstr :5000

# Kill conflicting processes if needed
taskkill /F /PID [process_id]

# React will auto-increment to next available port (3001, 3002, etc.)
```

### File Structure
```
retell-ai-dashboard/
├── backend/
│   ├── config/
│   │   ├── retell.js          # Retell AI integration
│   │   └── officeAgents.js    # Agent filtering config
│   ├── routes/
│   │   ├── calls.js           # Call management APIs
│   │   └── agents.js          # Agent management APIs
│   └── server.js              # Express server
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.js   # Main dashboard with agent filtering
│   │   │   └── Agents.js      # Agent management page
│   │   ├── config/
│   │   │   └── officeConfig.js # Frontend office configurations
│   │   └── services/
│   │       └── api.js         # API service layer
│   └── build/                 # Production build output
└── package.json               # Root package with dev scripts
```

---

## 🧪 Testing Procedures

### Local Testing Checklist

**Before Making Changes:**
1. ✅ Ensure `npm run dev` starts both services
2. ✅ Verify API health: `http://localhost:5000/api/health`
3. ✅ Verify frontend loads: `http://localhost:3000` (or auto-assigned port)
4. ✅ Test agent filtering dropdown functionality
5. ✅ Test office selector in both Dashboard and Agents pages

**After Making Changes:**
1. ✅ Restart dev server: `Ctrl+C` then `npm run dev`
2. ✅ Check for linting errors in terminal output
3. ✅ Test affected functionality thoroughly
4. ✅ Verify API responses with browser dev tools

### Production Testing

**Before Deployment:**
```powershell
# 1. Build frontend locally to catch errors
cd frontend
$env:REACT_APP_API_URL="http://159.89.82.167/api"
npm run build

# 2. Check for build errors or warnings
# 3. Test built files locally if needed
npx serve -s build -l 3005
```

**After Deployment:**
```powershell
# 1. Test API health
curl "http://159.89.82.167/api/health"

# 2. Test agent filtering
curl "http://159.89.82.167/api/calls?office_id=office_main&limit=3"

# 3. Verify frontend loads
curl "http://159.89.82.167/" | Select-Object -First 3
```

---

## 🚀 Production Deployment

### Current Production Environment

**Server Details:**
- **URL**: http://159.89.82.167/
- **Provider**: DigitalOcean Basic Droplet ($6/month)
- **OS**: Ubuntu 20.04 LTS
- **Process Manager**: PM2
- **Web Server**: Nginx
- **SSH Access**: `ssh root@159.89.82.167`

### Deployment Methods

#### Method 1: Quick File Updates (Recommended)

**For frontend changes:**
```powershell
# 1. Build locally
cd frontend
$env:REACT_APP_API_URL="http://159.89.82.167/api"
npm run build

# 2. Upload build
cd ..
scp -r frontend/build/* root@159.89.82.167:/root/retell-ai-dashboard/frontend/build/

# 3. Upload source files (for future rebuilds)
scp frontend/src/pages/Dashboard.js root@159.89.82.167:/root/retell-ai-dashboard/frontend/src/pages/
scp frontend/src/config/officeConfig.js root@159.89.82.167:/root/retell-ai-dashboard/frontend/src/config/
```

**For backend changes:**
```powershell
# Upload backend files
scp backend/routes/calls.js root@159.89.82.167:/root/retell-ai-dashboard/backend/routes/
scp backend/config/officeAgents.js root@159.89.82.167:/root/retell-ai-dashboard/backend/config/

# Restart backend service
ssh root@159.89.82.167 "pm2 restart retell-backend"
```

#### Method 2: Git-Based Deployment

**⚠️ Note: Large files may cause Git push failures**

```powershell
# 1. Commit changes locally
git add .
git commit -m "Your descriptive commit message"
git push origin main

# 2. Pull on server and restart
ssh root@159.89.82.167 "cd /root/retell-ai-dashboard && git pull origin main && pm2 restart all"
```

### PM2 Management

**Common PM2 Commands:**
```bash
# Check service status
pm2 status

# Restart services
pm2 restart all
pm2 restart retell-backend
pm2 restart retell-frontend

# View logs
pm2 logs retell-backend --lines 20
pm2 logs retell-frontend --lines 20

# Service details
pm2 describe retell-backend
```

---

## 🏢 Agent Filtering Configuration

### System Architecture

The agent filtering system has two configuration files that must stay synchronized:

1. **Backend**: `backend/config/officeAgents.js`
2. **Frontend**: `frontend/src/config/officeConfig.js`

### Adding New Office Configurations

**Step 1: Backend Configuration**
```javascript
// backend/config/officeAgents.js
office_pediatrics: {
  allowedAgents: ['1', '6'], // Medical Receptionist + Pediatric Specialist
  officeId: 'office_pediatrics',
  officeName: 'Pediatrics Department'
}
```

**Step 2: Frontend Configuration**
```javascript
// frontend/src/config/officeConfig.js
{
  id: 'office_pediatrics',
  name: 'Pediatrics Department',
  description: 'Child-focused medical care',
  allowedAgents: ['1', '6'] // Must match backend exactly
}
```

**Step 3: Deploy Both Files**
```powershell
scp backend/config/officeAgents.js root@159.89.82.167:/root/retell-ai-dashboard/backend/config/
scp frontend/src/config/officeConfig.js root@159.89.82.167:/root/retell-ai-dashboard/frontend/src/config/
ssh root@159.89.82.167 "pm2 restart retell-backend"
```

### Agent ID Management

**Current Agent Mapping:**
- **Agent 1**: Medical Receptionist
- **Agent 2**: Emergency Triage  
- **Agent 3**: Billing Support
- **Agent 4**: Appointment Scheduler

**To Add New Agents:**
1. Create agent in Retell AI dashboard
2. Note the agent ID
3. Add to relevant office configurations
4. Deploy updated configs

---

## 🔧 Development Best Practices

### Code Organization

**Frontend Structure:**
- **Pages**: Main page components (`Dashboard.js`, `Agents.js`)
- **Components**: Reusable UI components
- **Services**: API communication layer
- **Config**: Environment and office configurations

**Backend Structure:**
- **Routes**: API endpoint handlers
- **Config**: Service configurations and office settings
- **Middleware**: Authentication, CORS, error handling

### Development Workflow

1. **Always start with**: `npm run dev`
2. **Make changes** in small, testable increments
3. **Test locally** before deploying
4. **Use consistent naming** for office IDs and agent IDs
5. **Keep configs synchronized** between frontend and backend

### Common Pitfalls

**❌ Don't:**
- Use individual `npm start` commands for development
- Forget to rebuild frontend after changes
- Miss updating both config files when changing office settings
- Deploy without testing locally first
- Ignore linting warnings

**✅ Do:**
- Use `npm run dev` for development
- Build frontend before deploying
- Keep backend and frontend configs synchronized
- Test agent filtering after each change
- Monitor PM2 logs after deployment

---

## 🐛 Troubleshooting Guide

### Common Issues & Solutions

#### 1. "ERR_CONNECTION_REFUSED" on Local Development

**Problem**: Frontend can't connect to backend
**Solution**:
```powershell
# Stop all npm processes
Ctrl+C (in terminal)
taskkill /F /IM node.exe

# Restart properly
npm run dev
```

#### 2. Port Conflicts (3000, 5000)

**Problem**: Ports already in use
**Solution**:
```powershell
# Check what's using the port
netstat -ano | findstr :3000

# Kill process or use different port
# React will auto-increment if 3000 is busy
```

#### 3. Agent Filter Not Working

**Problem**: Dropdown shows all agents instead of office-specific
**Checklist**:
- ✅ Both config files updated?
- ✅ Agent IDs match exactly between frontend/backend?
- ✅ Backend restarted after config change?
- ✅ Office selector working properly?

#### 4. Build Failures

**Problem**: `npm run build` fails
**Common Causes**:
- Missing environment variables
- Linting errors
- Import/export issues
- Memory issues on server

**Solution**:
```powershell
# Check for specific errors in build output
npm run build 2>&1 | Tee-Object build.log

# Fix linting errors first
npm run lint
```

#### 5. PM2 Services Not Starting

**Problem**: Services show as "stopped" in PM2
**Solution**:
```bash
# Check logs for errors
pm2 logs retell-backend --lines 50

# Common fixes
pm2 restart all
pm2 delete all && pm2 start server.js --name retell-backend
```

### Debugging Tools

**Local Development:**
- Browser DevTools (Network tab for API calls)
- VS Code debugger
- `console.log()` statements
- React Developer Tools

**Production:**
- PM2 logs: `pm2 logs --lines 50`
- API testing: `curl` commands
- Server logs: `/var/log/nginx/`

---

## 📚 Additional Resources

### Documentation Files
- **`PRODUCTION_SETUP.md`**: Complete DigitalOcean setup guide
- **`OFFICE_DEPLOYMENT_GUIDE.md`**: Office-specific deployment strategies
- **`TROUBLESHOOTING.md`**: Common issues and solutions
- **`WORKFLOW.md`**: Development workflow details

### API Endpoints
- **Health Check**: `GET /api/health`
- **Calls**: `GET /api/calls?office_id=office_main`
- **Agents**: `GET /api/agents`
- **Call Details**: `GET /api/calls/:id`

### Key Commands Reference

```powershell
# Development
npm run dev                    # Start both services
npm run install:all           # Install all dependencies

# Building  
cd frontend && npm run build  # Build production frontend

# Deployment
scp -r build/* root@server:/path/   # Upload files
ssh root@server "pm2 restart all"  # Restart services

# Debugging
curl "http://server/api/health"     # Test API
pm2 logs --lines 20               # Check logs
netstat -ano | findstr :3000      # Check ports
```

---

## 🎯 Success Criteria

### Local Development Ready When:
- ✅ `npm run dev` starts both services without errors
- ✅ Frontend loads at `http://localhost:3000` (or assigned port)
- ✅ API responds at `http://localhost:5000/api/health`
- ✅ Agent filtering dropdown works correctly
- ✅ Office selector changes agent visibility

### Production Deployment Ready When:
- ✅ Local build completes without errors
- ✅ All tests pass locally
- ✅ Configuration files are synchronized
- ✅ Production API responds correctly
- ✅ Agent filtering works on live server
- ✅ PM2 services are stable

---

## 📞 Support & Maintenance

**For Future Developers:**
1. **Read this guide completely** before starting
2. **Test locally first** - always
3. **Keep configs synchronized** between frontend/backend
4. **Monitor PM2 logs** after deployments
5. **Document any new processes** you discover

**Production Server Monitoring:**
- **URL**: http://159.89.82.167/
- **SSH**: `ssh root@159.89.82.167`
- **PM2 Status**: `pm2 status`
- **Cost**: $6/month DigitalOcean droplet

**Key Learnings:**
- Use `npm run dev` for development (not individual starts)
- Frontend build must happen locally (server has limited resources)
- Agent filtering requires synchronized configs
- PM2 provides excellent process management
- File uploads are faster than Git for quick changes

---

**Last Updated**: August 2025  
**Project Status**: ✅ Production Ready with Agent Filtering  
**Current Version**: Enhanced with office-specific agent visibility