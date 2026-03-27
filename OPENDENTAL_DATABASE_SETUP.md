# Open Dental Database Connection Setup

This project now supports direct database connection to Open Dental, similar to your working Python project.

## 🔧 **Environment Variables**

Set this environment variable to connect to your Open Dental database:

```bash
# Direct MySQL database connection
OPENDENTAL_DB_URL=mysql://username:password@host:port/database_name

# Example formats:
OPENDENTAL_DB_URL=mysql://root:@localhost:3306/opendental
OPENDENTAL_DB_URL=mysql://oduser:password@192.168.1.100:3306/opendental
OPENDENTAL_DB_URL=mysql://root:@10.20.30.250:3306/opendental
```

## 🚀 **Quick Setup Steps**

1. **Set the environment variable:**
   ```bash
   # Windows PowerShell
   $env:OPENDENTAL_DB_URL="mysql://root:@your-server-ip:3306/opendental"
   
   # Linux/Mac
   export OPENDENTAL_DB_URL="mysql://root:@your-server-ip:3306/opendental"
   ```

2. **Install dependencies:**
   ```bash
   cd backend
   npm install
   ```

3. **Restart the services:**
   ```bash
   docker-compose -f docker-compose.dev.yml down
   docker-compose -f docker-compose.dev.yml up --build
   ```

4. **Test the connection:**
   ```bash
   curl http://localhost:5001/api/opendental/health
   ```

## 📋 **What's Supported**

The following features now work with direct database connection:

✅ **Calendar View** - View appointments by date
✅ **Provider Management** - List active providers  
✅ **Operatory Management** - List active operatories
✅ **Patient Search** - Search by name, phone, email
✅ **Real-time Sync** - Periodic data refresh

## 🔍 **Testing**

After setup, test these endpoints:

- **Health Check:** `GET /api/opendental/health`
- **Calendar:** `GET /api/opendental/calendar?date=2024-01-15`
- **Providers:** `GET /api/opendental/providers`
- **Operatories:** `GET /api/opendental/operatories`
- **Patient Search:** `GET /api/opendental/patients/search?q=smith`

## 🆘 **Troubleshooting**

**Connection Failed?**
1. Verify MySQL server is accessible from this machine
2. Check if port 3306 is open/accessible
3. Confirm username/password are correct
4. Ensure Open Dental database is running

**Common Connection Strings:**
```bash
# No password (common in dental offices)
OPENDENTAL_DB_URL=mysql://root:@10.20.30.250:3306/opendental

# With password
OPENDENTAL_DB_URL=mysql://oduser:password@192.168.1.100:3306/opendental

# Localhost
OPENDENTAL_DB_URL=mysql://root:@localhost:3306/opendental
```

## 📊 **Database Tables Used**

- `appointment` - Appointment scheduling
- `patient` - Patient demographics  
- `provider` - Healthcare providers
- `operatory` - Treatment rooms/operatories

The system automatically falls back to mock data if the database connection fails.