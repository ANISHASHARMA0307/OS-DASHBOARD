// script.js
let cpuChart, ramChart;
const cpuEl = document.getElementById('cpu');
const ramEl = document.getElementById('ram');
const batteryEl = document.getElementById('battery');
const gpuEl = document.getElementById('gpuInfo');
const procList = document.getElementById('processList');
const logArea = document.getElementById('logArea');
const refreshBtn = document.getElementById('refreshLogs');
const downloadCsv = document.getElementById('downloadCsv');
const downloadPdf = document.getElementById('downloadPdf');
const themeToggle = document.getElementById('themeToggle');

if (localStorage.getItem('theme') === 'dark') document.body.classList.add('dark');
themeToggle?.addEventListener('click', () => {
  document.body.classList.toggle('dark');
  localStorage.setItem('theme', document.body.classList.contains('dark') ? 'dark':'light');
});
downloadCsv?.addEventListener('click', ()=> window.location.href='/api/snapshot?fmt=csv');
downloadPdf?.addEventListener('click', ()=> window.location.href='/api/snapshot?fmt=pdf');
refreshBtn?.addEventListener('click', fetchLogs);

// init charts
function initCharts(){
  const cpuCtx = document.getElementById('cpuChart').getContext('2d');
  const ramCtx = document.getElementById('ramChart').getContext('2d');

  cpuChart = new Chart(cpuCtx, {
    type:'line',
    data:{ labels:[], datasets:[{ label:'CPU %', data:[], borderColor:'#ef4444', backgroundColor:'rgba(239,68,68,0.08)', fill:true, tension:0.3 }]},
    options:{ responsive:true, animation:false, scales:{ y:{ min:0, max:100 } }, plugins:{legend:{display:false}}}
  });

  ramChart = new Chart(ramCtx, {
    type:'line',
    data:{ labels:[], datasets:[{ label:'RAM %', data:[], borderColor:'#3b82f6', backgroundColor:'rgba(59,130,246,0.08)', fill:true, tension:0.3 }]},
    options:{ responsive:true, animation:false, scales:{ y:{ min:0, max:100 } }, plugins:{legend:{display:false}}}
  });
}

// fetch stats and update UI
async function fetchStats(){
  try{
    const res = await fetch('/api/stats');
    if(!res.ok) throw new Error('No stats');
    const d = await res.json();

    cpuEl.textContent = `${d.cpu ?? d.cpuLoad ?? 0}%`;
    ramEl.textContent = `${d.ram ?? d.usedMem ?? 0}%`;
    batteryEl.textContent = (d.battery==null || d.battery==='N/A') ? 'N/A' : d.battery + '%';
    gpuEl.textContent = (d.gpu && Array.isArray(d.gpu) && d.gpu.length) ? d.gpu[0].model || d.gpu : (d.gpu || 'N/A');

    // update charts
    const now = new Date().toLocaleTimeString();
    pushChart(cpuChart, now, Number(d.cpu ?? d.cpuLoad ?? 0));
    pushChart(ramChart, now, Number(d.ram ?? d.usedMem ?? 0));

    // notifications / alerts (simple)
    checkAlerts(Number(d.cpu ?? d.cpuLoad ?? 0), Number(d.ram ?? d.usedMem ?? 0), d.battery);
  }catch(err){
    console.error('fetchStats', err);
  }
}

function pushChart(chart, label, value){
  chart.data.labels.push(label);
  chart.data.datasets[0].data.push(value);
  if(chart.data.labels.length > 30){
    chart.data.labels.shift(); chart.data.datasets[0].data.shift();
  }
  chart.update();
}

// get processes
async function fetchProcesses(){
  try{
    const res = await fetch('/api/processes');
    const list = await res.json();
    procList.innerHTML = '';
    if(Array.isArray(list) && list.length){
      list.forEach(p=>{
        const li = document.createElement('li');
        li.textContent = `${p.name} (PID:${p.pid ?? '-'}) — CPU:${p.cpu}% RAM:${p.mem}%`;
        procList.appendChild(li);
      });
    } else {
      procList.innerHTML = '<li>No processes data</li>';
    }
  }catch(err){
    console.error('fetchProcesses', err);
    procList.innerHTML = '<li>Error fetching processes</li>';
  }
}

// logs
async function fetchLogs(){
  try{
    const res = await fetch('/api/logs?n=200');
    if(!res.ok) throw new Error('no logs');
    const lines = await res.json();
    // lines is array
    logArea.value = Array.isArray(lines) ? lines.join('\n') : (typeof lines === 'string' ? lines : '');
  }catch(err){
    console.error('fetchLogs', err);
    logArea.value = 'Error loading logs';
  }
}

// alerts with throttling; reads thresholds from server if available
let lastAlert = {cpu:0, ram:0, battery:0};
async function checkAlerts(cpu, ram, battery){
  try{
    const r = await fetch('/api/thresholds');
    const th = r.ok ? await r.json() : {cpu:90, ram:85, battery:15};
    const now = Date.now();
    if(cpu >= th.cpu && (now - lastAlert.cpu) > 1000*60*3){ notify(`High CPU: ${cpu}%`); lastAlert.cpu = now; }
    if(ram >= th.ram && (now - lastAlert.ram) > 1000*60*3){ notify(`High RAM: ${ram}%`); lastAlert.ram = now; }
    if(battery !== null && battery !== 'N/A' && battery <= th.battery && (now - lastAlert.battery) > 1000*60*30){ notify(`Low Battery: ${battery}%`); lastAlert.battery = now; }
  }catch(e){ console.error('checkAlerts', e); }
}

function notify(msg){
  if("Notification" in window && Notification.permission === "granted"){
    new Notification('OS Dashboard', { body: msg });
  } else if("Notification" in window && Notification.permission !== "denied"){
    Notification.requestPermission().then(p => { if(p === 'granted') new Notification('OS Dashboard', { body: msg }); });
  } else {
    // fallback console
    console.log('ALERT:', msg);
  }
}

// initialize
window.addEventListener('load', ()=>{
  initCharts();
  fetchStats(); fetchProcesses(); fetchLogs();
  setInterval(fetchStats, 3000);
  setInterval(fetchProcesses, 5000);
  setInterval(fetchLogs, 15000);
});
