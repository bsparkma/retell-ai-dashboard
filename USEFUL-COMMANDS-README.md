Running under PM2:

carein-backend → port 5003, PID 15544, online
carein-dashboard → port 3005, PID 41180, online
Both responding 200 from http://10.20.30.160:*
Persistence:

pm2 save wrote the process list to ~/.pm2/dump.pm2
pm2-windows-startup is registered — on next Windows logon, pm2 resurrect runs and restores both apps automatically
Useful PM2 commands going forward:


pm2 status                    # see what's running
pm2 logs carein-backend       # tail backend logs
pm2 logs carein-dashboard     # tail dashboard logs
pm2 restart carein-backend    # restart one app (e.g. after .env change)
pm2 restart all               # restart everything
pm2 stop all                  # stop everything (won't auto-resurrect until next logon)
pm2 save                      # rerun this any time you change which apps PM2 manages
Logs also written to logs/backend-*.log and logs/dashboard-*.log in the project root.

Two things still left for you:

Firewall rule for port 5003 — if her browser still can't reach http://10.20.30.160:5003/api/health, run this in admin PowerShell:


New-NetFirewallRule -DisplayName "CareIN Backend 5003" -Direction Inbound -Protocol TCP -LocalPort 5003 -Action Allow
New-NetFirewallRule -DisplayName "CareIN Dashboard 3005" -Direction Inbound -Protocol TCP -LocalPort 3005 -Action Allow
Reboot test — once you're at a good stopping point, log out and back in (or full reboot) and run pm2 status. Both apps should be online without you doing anything. If they aren't, we'll troubleshoot the resurrect step.