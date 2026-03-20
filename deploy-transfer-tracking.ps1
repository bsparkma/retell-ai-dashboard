# Transfer Tracking Deployment Script
# This script deploys the new transfer tracking features to production

Write-Host "🚀 Deploying Transfer Tracking Features to Production" -ForegroundColor Green
Write-Host "=================================================" -ForegroundColor Green

# Configuration
$SERVER_IP = "159.89.82.167"
$PROJECT_PATH = "C:\Users\beau\carein cursor dashboard"
$REMOTE_PATH = "/root/retell-ai-dashboard"

Write-Host "📋 Deployment Configuration:" -ForegroundColor Yellow
Write-Host "  Server IP: $SERVER_IP"
Write-Host "  Local Path: $PROJECT_PATH"
Write-Host "  Remote Path: $REMOTE_PATH"
Write-Host ""

# Step 1: Build Frontend Locally
Write-Host "🔨 Step 1: Building Frontend Locally..." -ForegroundColor Cyan
Set-Location "$PROJECT_PATH\frontend"

# Set production API URL
$env:REACT_APP_API_URL = "http://$SERVER_IP/api"
Write-Host "  ✅ Set REACT_APP_API_URL to: $env:REACT_APP_API_URL"

# Build the project
Write-Host "  🔄 Running npm run build..."
npm run build

if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✅ Frontend build completed successfully!" -ForegroundColor Green
} else {
    Write-Host "  ❌ Frontend build failed!" -ForegroundColor Red
    exit 1
}

# Step 2: Upload Backend Changes
Write-Host ""
Write-Host "📤 Step 2: Uploading Backend Changes..." -ForegroundColor Cyan
Set-Location "$PROJECT_PATH\backend"

Write-Host "  🔄 Uploading backend files..."
scp -r routes\calls.js root@${SERVER_IP}:${REMOTE_PATH}/backend/routes/
scp -r package.json root@${SERVER_IP}:${REMOTE_PATH}/backend/

if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✅ Backend files uploaded successfully!" -ForegroundColor Green
} else {
    Write-Host "  ❌ Backend upload failed!" -ForegroundColor Red
    exit 1
}

# Step 3: Upload Frontend Build
Write-Host ""
Write-Host "📤 Step 3: Uploading Frontend Build..." -ForegroundColor Cyan
Set-Location "$PROJECT_PATH\frontend"

Write-Host "  🔄 Uploading frontend build files..."
scp -r build\* root@${SERVER_IP}:${REMOTE_PATH}/frontend/build/

if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✅ Frontend build uploaded successfully!" -ForegroundColor Green
} else {
    Write-Host "  ❌ Frontend upload failed!" -ForegroundColor Red
    exit 1
}

# Step 4: Restart Services on Server
Write-Host ""
Write-Host "🔄 Step 4: Restarting Services on Production Server..." -ForegroundColor Cyan

$RESTART_COMMANDS = @"
cd $REMOTE_PATH/backend
npm install --production
pm2 restart retell-backend
pm2 restart retell-frontend
pm2 status
"@

Write-Host "  🔄 Executing restart commands on server..."
ssh root@$SERVER_IP $RESTART_COMMANDS

if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✅ Services restarted successfully!" -ForegroundColor Green
} else {
    Write-Host "  ❌ Service restart failed!" -ForegroundColor Red
    exit 1
}

# Step 5: Verification
Write-Host ""
Write-Host "✅ Step 5: Deployment Verification" -ForegroundColor Cyan
Write-Host "  🌐 Dashboard URL: http://$SERVER_IP"
Write-Host "  🔍 API Health Check: http://$SERVER_IP/api/health"
Write-Host "  📊 API Calls Endpoint: http://$SERVER_IP/api/calls"
Write-Host ""

Write-Host "🎉 Transfer Tracking Deployment Complete!" -ForegroundColor Green
Write-Host "=================================================" -ForegroundColor Green
Write-Host ""
Write-Host "📋 New Features Deployed:" -ForegroundColor Yellow
Write-Host "  ✅ Transfer status tracking (successful, failed, voicemail)"
Write-Host "  ✅ Callback required indicators"
Write-Host "  ✅ Transfer success rate statistics"
Write-Host "  ✅ Transfer status filter in dashboard"
Write-Host "  ✅ Transfer details in call drawer"
Write-Host "  ✅ Enhanced statistics cards with transfer metrics"
Write-Host ""
Write-Host "🔍 Please verify the following:" -ForegroundColor Yellow
Write-Host "  1. Open http://$SERVER_IP in your browser"
Write-Host "  2. Check that new transfer statistics cards are visible"
Write-Host "  3. Verify transfer status column in the calls table"
Write-Host "  4. Test the transfer filter dropdown"
Write-Host "  5. Open a call details to see transfer information"
Write-Host ""
Write-Host "📞 If you encounter any issues:" -ForegroundColor Yellow
Write-Host "  - SSH to server: ssh root@$SERVER_IP"
Write-Host "  - Check logs: pm2 logs"
Write-Host "  - Check status: pm2 status"
Write-Host ""

# Return to original directory
Set-Location $PROJECT_PATH

