#!/bin/bash

echo "🚀 Setting up Retell AI Dashboard..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js (v16 or higher) first."
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 16 ]; then
    echo "❌ Node.js version 16 or higher is required. Current version: $(node -v)"
    exit 1
fi

echo "✅ Node.js $(node -v) detected"

# Install root dependencies
echo "📦 Installing root dependencies..."
npm install

# Install backend dependencies
echo "📦 Installing backend dependencies..."
cd backend
npm install
cd ..

# Install frontend dependencies
echo "📦 Installing frontend dependencies..."
cd frontend
npm install
cd ..

# Create backend .env file if it doesn't exist
if [ ! -f "backend/.env" ]; then
    echo "📝 Creating backend .env file..."
    if [ -f "backend/.env.example" ]; then
        cp backend/.env.example backend/.env
        echo "✅ Created backend/.env from .env.example — fill in RETELL_API_KEY before starting"
    else
        cat > backend/.env <<'EOF'
RETELL_API_KEY=<set-me>
PORT=5000
NODE_ENV=development
CORS_ORIGIN=http://localhost:3000
EOF
        echo "⚠️  Created backend/.env with placeholder values. Set RETELL_API_KEY before starting."
    fi
fi

echo ""
echo "🎉 Setup complete!"
echo ""
echo "To start the development server:"
echo "  npm run dev"
echo ""
echo "To start individual services:"
echo "  Backend only: npm run backend:dev"
echo "  Frontend only: npm run frontend:dev"
echo ""
echo "📊 Dashboard will be available at: http://localhost:3000"
echo "🔧 Backend API will be available at: http://localhost:5000" 