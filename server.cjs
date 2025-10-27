/* server.cjs - fixed, robust version */
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

/* /api/stats */
app.get('/api/stats', async (req, res) => {
  try {
    const [cpuLoad, mem, battery, fsSize, graphics] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.battery(),
      si.fsSize(),
      si.graphics()
    ]);

    const cpu = Number(cpuLoad.currentLoad?.toFixed?.(2) ?? cpuLoad.currentLoad ?? 0);
    const ram = Number((((mem?.active ?? 0) / (mem?.total ?? 1)) * 100).toFixed(2));
    const batteryPct = battery?.hasbattery ? (battery.percent ?? null) : null;

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

/* /api/processes - robust safe mapping */
app.get('/api/processes', async (req, res) => {
  try {
    const procInfo = await si.processes();
    const list = procInfo?.list || [];

    const safeNum = v => {
      if (v === undefined || v === null) return 0;
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    const mapped = list.map(p => {
      const cpuRaw = p.pcpu ?? p.cpu ?? p.cpuPercent ?? p.cpuUsage ?? 0;
      const memRaw = p.pmem ?? p.mem ?? p.memPercent ?? 0;
      const cpu = Number(safeNum(cpuRaw));
      const memv = Number(safeNum(memRaw));
      return {
        pid: p.pid ?? null,
        name: p.name ?? p.command ?? 'unknown',
        cpu: Math.round(cpu * 100) / 100,
        mem: Math.round(memv * 100) / 100
      };
    });

    const top = mapped.sort((a,b) => (b.cpu ?? 0) - (a.cpu ?? 0)).slice(0,5);
    res.json(top);
  } catch (err) {
    console.error('/api/processes error', err);
    res.status(500).json({ error: err.message });
  }
});

/* /api/logs - last N lines */
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

/* /api/snapshot - csv or pdf */
app.get('/api/snapshot', async (req, res) => {
  try {
    const fmt = (req.query.fmt || 'csv').toLowerCase();
    const [stats, mem, battery, procs] = await Promise.all([si.currentLoad(), si.mem(), si.battery(), si.processes()]);

    const time = new Date().toISOString();
    const cpuVal = Number(stats.currentLoad?.toFixed?.(2) ?? stats.currentLoad ?? 0);
    const ramVal = Number((((mem?.active ?? 0)/(mem?.total ?? 1))*100).toFixed(2));
    const batteryVal = battery?.hasbattery ? (battery.percent ?? 'N/A') : 'N/A';
    const topProcs = (procs?.list || []).sort((a,b)=> (b.pcpu ?? b.cpu ?? 0) - (a.pcpu ?? a.cpu ?? 0)).slice(0,10);

    if (fmt === 'pdf') {
      res.setHeader('Content-disposition','attachment; filename=dash-snapshot.pdf');
      res.setHeader('Content-type','application/pdf');
      const doc = new PDFDocument();
      doc.pipe(res);
      doc.fontSize(16).text('OS Dashboard Snapshot', {underline:true});
      doc.moveDown();
      doc.text(`Time: ${time}`);
      doc.text(`CPU: ${cpuVal}%`);
      doc.text(`RAM: ${ramVal}%`);
      doc.text(`Battery: ${batteryVal}`);
      doc.moveDown();
      doc.text('Top processes (sample):');
      topProcs.forEach(p => doc.text(`${p.pid} ${p.name} — CPU:${p.pcpu ?? p.cpu ?? 0}% MEM:${p.pmem ?? p.mem ?? 0}%`));
      doc.end();
      return;
    } else {
      let csv = `time,cpu%,ram%,battery%\n`;
      csv += `${time},${cpuVal},${ramVal},${batteryVal}\n\n`;
      csv += `pid,name,cpu,mem\n`;
      topProcs.forEach(p => {
        const cpu = p.pcpu ?? p.cpu ?? 0;
        const memv = p.pmem ?? p.mem ?? 0;
        csv += `${p.pid},"${(p.name||'').replace(/"/g,'""')}",${cpu},${memv}\n`;
      });
      res.setHeader('Content-disposition','attachment; filename=dash-snapshot.csv');
      res.setHeader('Content-type','text/csv');
      res.send(csv);
      return;
    }
  } catch (err) {
    console.error('/api/snapshot error', err);
    res.status(500).json({ error: err.message });
  }
});

/* thresholds get/post */
app.get('/api/thresholds', (req,res) => res.json(thresholds));
app.post('/api/thresholds', (req,res) => {
  try {
    const b = req.body || {};
    if (typeof b.cpu === 'number') thresholds.cpu = b.cpu;
    if (typeof b.ram === 'number') thresholds.ram = b.ram;
    if (typeof b.battery === 'number') thresholds.battery = b.battery;
    res.json({ success:true, thresholds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* cron: log every minute (nonblocking) */
cron.schedule('* * * * *', async () => {
  try {
    const [cpu, mem, battery] = await Promise.all([si.currentLoad(), si.mem(), si.battery()]);
    const cpuVal = Number(cpu.currentLoad?.toFixed?.(2) ?? cpu.currentLoad ?? 0);
    const ramVal = Number((((mem?.active ?? 0)/(mem?.total ?? 1))*100).toFixed(2));
    const battVal = battery?.hasbattery ? (battery.percent ?? 'N/A') : 'N/A';
    const line = `[${new Date().toLocaleString()}] CPU:${cpuVal}% RAM:${ramVal}% Battery:${battVal}`;
    appendLogAsync(line);
  } catch (err) {
    console.error('cron error', err);
  }
});

/* serve index explicitly */
app.get('/', (req,res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
