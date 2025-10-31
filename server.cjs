/* server.cjs - improved version with better battery detection */
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
const LOG_FILE = path.join(LOG_DIR, 'resource.log');

let thresholds = { cpu: 90, ram: 85, battery: 15 };

// Async append log (non-blocking)
function appendLogAsync(line) {
  fs.appendFile(LOG_FILE, line + '\n', (err) => {
    if (err) console.error('Failed to append log:', err);
  });
}

/* Helper: better battery detection */
async function getBatteryInfo() {
  try {
    const battery = await si.battery();

    // Some Windows laptops report hasbattery = false even when they do
    if (
      battery &&
      (battery.hasbattery || battery.percent > 0 || battery.maxcapacity > 0)
    ) {
      return battery.percent ?? null;
    }

    // fallback: try power supply info (Linux/Win hybrid fallback)
    const ps = await si.powerSupply();
    if (ps && ps.percent) return ps.percent;

    return null; // if truly unavailable
  } catch (err) {
    console.warn('Battery info unavailable:', err.message);
    return null;
  }
}

/* /api/stats */
app.get('/api/stats', async (req, res) => {
  try {
    const [cpuLoad, mem, fsSize, graphics] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.graphics()
    ]);

    const batteryPct = await getBatteryInfo();

    const cpu = Number(cpuLoad.currentLoad?.toFixed?.(2) ?? 0);
    const ram = Number((((mem?.active ?? 0) / (mem?.total ?? 1)) * 100).toFixed(2));

    const ssd = (fsSize || []).map(d => ({
      fs: d.fs, mount: d.mount, size: d.size, used: d.used, use: d.use
    }));

    const gpu = (graphics?.controllers || []).map(g => ({
      model: g.model || 'unknown',
      vendor: g.vendor || '',
      vram: g.vram || 0,
      utilizationGpu: g.utilizationGpu ?? null
    }));

    res.json({ cpu, ram, battery: batteryPct, ssd, gpu });
  } catch (err) {
    console.error('/api/stats error', err);
    res.status(500).json({ error: err.message });
  }
});

/* /api/processes */
app.get('/api/processes', async (req, res) => {
  try {
    const procInfo = await si.processes();
    const list = procInfo?.list || [];

    const mapped = list.map(p => ({
      pid: p.pid ?? null,
      name: p.name ?? p.command ?? 'unknown',
      cpu: Number(p.pcpu ?? p.cpu ?? 0).toFixed(2),
      mem: Number(p.pmem ?? p.mem ?? 0).toFixed(2)
    }));

    const top = mapped.sort((a, b) => b.cpu - a.cpu).slice(0, 5);
    res.json(top);
  } catch (err) {
    console.error('/api/processes error', err);
    res.status(500).json({ error: err.message });
  }
});

/* /api/logs */
app.get('/api/logs', (req, res) => {
  try {
    if (!fs.existsSync(LOG_FILE)) return res.json([]);
    const n = parseInt(req.query.n, 10) || 200;
    const all = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n');
    res.json(all.slice(-n));
  } catch (err) {
    console.error('/api/logs error', err);
    res.status(500).json({ error: err.message });
  }
});

/* /api/snapshot (csv/pdf) */
app.get('/api/snapshot', async (req, res) => {
  try {
    const fmt = (req.query.fmt || 'csv').toLowerCase();
    const [stats, mem, procs] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.processes()
    ]);
    const batteryVal = await getBatteryInfo();

    const time = new Date().toISOString();
    const cpuVal = Number(stats.currentLoad?.toFixed?.(2) ?? 0);
    const ramVal = Number((((mem?.active ?? 0) / (mem?.total ?? 1)) * 100).toFixed(2));
    const topProcs = (procs?.list || [])
      .sort((a, b) => (b.pcpu ?? 0) - (a.pcpu ?? 0))
      .slice(0, 10);

    if (fmt === 'pdf') {
      res.setHeader('Content-disposition', 'attachment; filename=dash-snapshot.pdf');
      res.setHeader('Content-type', 'application/pdf');
      const doc = new PDFDocument();
      doc.pipe(res);
      doc.fontSize(16).text('OS Dashboard Snapshot', { underline: true });
      doc.moveDown();
      doc.text(`Time: ${time}`);
      doc.text(`CPU: ${cpuVal}%`);
      doc.text(`RAM: ${ramVal}%`);
      doc.text(`Battery: ${batteryVal ?? 'N/A'}%`);
      doc.moveDown();
      doc.text('Top processes:');
      topProcs.forEach(p => doc.text(`${p.pid} ${p.name} — CPU:${p.pcpu ?? 0}% MEM:${p.pmem ?? 0}%`));
      doc.end();
    } else {
      let csv = `time,cpu%,ram%,battery%\n${time},${cpuVal},${ramVal},${batteryVal ?? 'N/A'}\n\npid,name,cpu,mem\n`;
      topProcs.forEach(p => {
        csv += `${p.pid},"${(p.name || '').replace(/"/g, '""')}",${p.pcpu ?? 0},${p.pmem ?? 0}\n`;
      });
      res.setHeader('Content-disposition', 'attachment; filename=dash-snapshot.csv');
      res.setHeader('Content-type', 'text/csv');
      res.send(csv);
    }
  } catch (err) {
    console.error('/api/snapshot error', err);
    res.status(500).json({ error: err.message });
  }
});

/* thresholds get/post */
app.get('/api/thresholds', (req, res) => res.json(thresholds));
app.post('/api/thresholds', (req, res) => {
  try {
    const b = req.body || {};
    if (typeof b.cpu === 'number') thresholds.cpu = b.cpu;
    if (typeof b.ram === 'number') thresholds.ram = b.ram;
    if (typeof b.battery === 'number') thresholds.battery = b.battery;
    res.json({ success: true, thresholds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* log cron job */
cron.schedule('* * * * *', async () => {
  try {
    const [cpu, mem] = await Promise.all([si.currentLoad(), si.mem()]);
    const batteryVal = await getBatteryInfo();
    const cpuVal = Number(cpu.currentLoad?.toFixed?.(2) ?? 0);
    const ramVal = Number((((mem?.active ?? 0) / (mem?.total ?? 1)) * 100).toFixed(2));
    const line = `[${new Date().toLocaleString()}] CPU:${cpuVal}% RAM:${ramVal}% Battery:${batteryVal ?? 'N/A'}%`;
    appendLogAsync(line);
  } catch (err) {
    console.error('cron error', err);
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));

