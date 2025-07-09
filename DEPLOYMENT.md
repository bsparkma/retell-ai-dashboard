# Deployment Guide

This guide covers different deployment options for the Retell AI Dashboard.

## Prerequisites

- Node.js (v16 or higher)
- npm or yarn
- Git
- Your Retell AI API key

## Local Development

### Quick Setup

```bash
# Make setup script executable (Linux/Mac)
chmod +x setup.sh

# Run setup script
./setup.sh

# Start development server
npm run dev
```

### Manual Setup

```bash
# Install all dependencies
npm run install:all

# Start development server
npm run dev
```

The dashboard will be available at `http://localhost:3000`

## Production Deployment

### Docker Deployment

1. **Prerequisites**: Docker and Docker Compose installed

2. **Setup**:
   ```bash
   # Clone the repository
   git clone <repository-url>
   cd retell-ai-dashboard
   
   # Copy environment variables
   cp backend/.env.example backend/.env
   
   # Edit backend/.env with your Retell AI API key
   ```

3. **Deploy**:
   ```bash
   docker-compose up -d
   ```

### Vercel (Frontend Only)

1. **Fork the repository** on GitHub

2. **Connect to Vercel**:
   - Visit [vercel.com](https://vercel.com)
   - Import your GitHub repository
   - Set the root directory to `frontend`

3. **Environment Variables**:
   ```
   REACT_APP_API_URL=https://your-backend-url.com/api
   ```

4. **Deploy**: Vercel will automatically deploy on push to main branch

### Railway (Full-Stack)

1. **Backend Deployment**:
   - Connect your GitHub repository to Railway
   - Set the root directory to `backend`
   - Add environment variables:
     ```
     RETELL_API_KEY=your_retell_api_key
     PORT=5000
     NODE_ENV=production
     ```

2. **Frontend Deployment**:
   - Create a new Railway service
   - Set the root directory to `frontend`
   - Add environment variable:
     ```
     REACT_APP_API_URL=https://your-backend-railway-url.railway.app/api
     ```

### Heroku

#### Backend

1. **Create Heroku app**:
   ```bash
   heroku create your-app-name-backend
   ```

2. **Set environment variables**:
   ```bash
   heroku config:set RETELL_API_KEY=your_api_key -a your-app-name-backend
   heroku config:set NODE_ENV=production -a your-app-name-backend
   ```

3. **Deploy**:
   ```bash
   git subtree push --prefix backend heroku main
   ```

#### Frontend

1. **Create Heroku app**:
   ```bash
   heroku create your-app-name-frontend
   ```

2. **Set buildpack**:
   ```bash
   heroku buildpacks:set mars/create-react-app -a your-app-name-frontend
   ```

3. **Set environment variables**:
   ```bash
   heroku config:set REACT_APP_API_URL=https://your-app-name-backend.herokuapp.com/api -a your-app-name-frontend
   ```

4. **Deploy**:
   ```bash
   git subtree push --prefix frontend heroku main
   ```

### AWS EC2

1. **Launch EC2 instance** (Ubuntu 20.04 LTS recommended)

2. **Install dependencies**:
   ```bash
   # Update system
   sudo apt update && sudo apt upgrade -y
   
   # Install Node.js
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs
   
   # Install PM2
   sudo npm install -g pm2
   
   # Install Nginx
   sudo apt install nginx -y
   ```

3. **Clone and setup**:
   ```bash
   git clone <repository-url>
   cd retell-ai-dashboard
   ./setup.sh
   ```

4. **Configure PM2**:
   ```bash
   # Start backend
   cd backend
   pm2 start server.js --name "retell-backend"
   
   # Build and serve frontend
   cd ../frontend
   npm run build
   pm2 serve build 3000 --name "retell-frontend"
   
   # Save PM2 configuration
   pm2 save
   pm2 startup
   ```

5. **Configure Nginx**:
   ```bash
   sudo nano /etc/nginx/sites-available/retell-dashboard
   ```
   
   Add configuration:
   ```nginx
   server {
       listen 80;
       server_name your-domain.com;
       
       location / {
           proxy_pass http://localhost:3000;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
       }
       
       location /api/ {
           proxy_pass http://localhost:5000/api/;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
       }
   }
   ```
   
   Enable the site:
   ```bash
   sudo ln -s /etc/nginx/sites-available/retell-dashboard /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl restart nginx
   ```

### DigitalOcean App Platform

1. **Create new app** in DigitalOcean App Platform

2. **Add backend service**:
   - Source: GitHub repository
   - Source Directory: `/backend`
   - Environment Variables:
     ```
     RETELL_API_KEY=your_api_key
     NODE_ENV=production
     ```

3. **Add frontend service**:
   - Source: GitHub repository
   - Source Directory: `/frontend`
   - Environment Variables:
     ```
     REACT_APP_API_URL=${backend.PUBLIC_URL}/api
     ```

## Environment Variables

### Backend (.env)
```
RETELL_API_KEY=your_retell_api_key_here
PORT=5000
NODE_ENV=production
CORS_ORIGIN=https://your-frontend-domain.com
```

### Frontend
```
REACT_APP_API_URL=https://your-backend-domain.com/api
```

## SSL Configuration

For production deployments, always use HTTPS:

1. **Let's Encrypt with Certbot** (for custom domains):
   ```bash
   sudo apt install certbot python3-certbot-nginx
   sudo certbot --nginx -d your-domain.com
   ```

2. **Cloud Provider SSL**: Most cloud providers offer free SSL certificates

## Monitoring and Maintenance

### Health Checks
- Backend: `GET /api/health`
- Frontend: Standard HTTP response check

### Logs
```bash
# PM2 logs
pm2 logs

# Docker logs
docker-compose logs -f

# Nginx logs
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

### Updates
```bash
# Pull latest changes
git pull origin main

# Update dependencies
npm run install:all

# Restart services
pm2 restart all
# or
docker-compose restart
```

## Troubleshooting

### Common Issues

1. **CORS Errors**: Ensure `CORS_ORIGIN` is set correctly in backend
2. **API Connection Issues**: Verify `REACT_APP_API_URL` in frontend
3. **Retell API Errors**: Check API key validity and rate limits
4. **Build Failures**: Ensure Node.js version compatibility

### Debug Mode
```bash
# Backend debug
cd backend
DEBUG=* npm run dev

# Frontend debug
cd frontend
REACT_APP_DEBUG=true npm start
``` 