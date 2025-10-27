# OS Dashboard (Final)

Simple OS Dashboard showing CPU, RAM, SSD, GPU (if available), Battery, top processes, logging, snapshot export, and dark/light theme.

## How to run (Ubuntu)
1. `npm install`
2. `node server.cjs`
3. Open http://localhost:3000

## Features
- Real-time CPU & RAM charts
- SSD usage summary
- Battery & GPU info (if available on the system)
- Top 5 processes (by CPU)
- Logs saved every 1 minute in `logs/resource.log`
- Snapshot (CSV/PDF)
- Alerts and theme toggle

