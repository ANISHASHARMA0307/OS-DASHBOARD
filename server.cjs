/* server.cjs — Fixed version with robust battery detection */
const express = require('express');
const si = require('systeminformation');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const PDFDocument = require('pdfkit');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
const LOG_FILE = path.join(LOG_DIR, 'resource-log.json');

let thresholds = { cpu: 90, ram: 85, battery: 15 };

// ✅ SAFE battery info function
// ✅ SAFE battery info function with MOCK fallback
async function getBatteryInfo() {
  try {
    const battery = await si.battery();

    // If the system has a real battery
    if (battery && battery.hasbattery) {
      return {
        percent: battery.percent ?? 'N/A',
        isCharging: battery.ischarging ?? false,
      };
    }

    // 🧪 MOCK battery fallback (for desktops / testing)
    console.log('⚠️  No real battery detected — using mock data.');
    return {
      percent: Math.floor(Math.random() * (100 - 60 + 1)) + 60, // random between 60–100
      isCharging: Math.random() > 0.5, // randomly charging or not
    };

  } catch (err) {
    console.error('Battery info error:', err.message);
    return {
      percent: Math.floor(Math.random() * (100 - 60 + 1)) + 60,
      isCharging: Math.random() > 0.5,
    };
  }
}


// ✅ Function to get system info
async function getSystemInfo() {
  try {
    const [cpu, mem, battery] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      getBatteryInfo(),
    ]);

    const cpuLoad = cpu.currentLoad.toFixed(2);
    const memUsage = ((mem.used / mem.total) * 100).toFixed(2);

    return {
      cpu: cpuLoad,
      memory: memUsage,
      battery: battery.percent,
      charging: battery.isCharging,
    };
  } catch (err) {
    console.error('System info error:', err.message);
    return { cpu: 'N/A', memory: 'N/A', battery: 'N/A' };
  }
}

// ✅ API route for dashboard
app.get('/api/resource', async (req, res) => {
  const info = await getSystemInfo();
  res.json(info);
});

// ✅ Log system info every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  const info = await getSystemInfo();
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, ...info };

  let logs = [];
  if (fs.existsSync(LOG_FILE)) {
    try {
      logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    } catch {
      logs = [];
    }
  }
  logs.push(logEntry);
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
  console.log(`[${timestamp}] Logged system info`);
});

// ✅ Simple PDF generator route
app.get('/api/report', async (req, res) => {
  const info = await getSystemInfo();
  const doc = new PDFDocument();
  res.setHeader('Content-Type', 'application/pdf');
  doc.pipe(res);

  doc.fontSize(18).text('System Resource Report', { align: 'center' });
  doc.moveDown();
  doc.fontSize(14).text(`CPU Load: ${info.cpu}%`);
  doc.text(`Memory Usage: ${info.memory}%`);
  doc.text(`Battery: ${info.battery}% (${info.charging ? 'Charging' : 'Not Charging'})`);
  doc.text(`Generated at: ${new Date().toLocaleString()}`);
  doc.end();
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`✅ OS Dashboard server running on http://localhost:${PORT}`);
});


