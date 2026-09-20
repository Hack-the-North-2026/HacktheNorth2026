const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match) {
      process.env[match[1]] = match[2] ? match[2].trim() : '';
    }
  }
}

let pythonExecutable = 'python';

const winVenvPython = path.join(__dirname, 'venv', 'Scripts', 'python.exe');
const posixVenvPython = path.join(__dirname, 'venv', 'bin', 'python');

if (fs.existsSync(winVenvPython)) {
  pythonExecutable = winVenvPython;
} else if (fs.existsSync(posixVenvPython)) {
  pythonExecutable = posixVenvPython;
}

const isDev = process.argv.includes('--dev');
const port = process.env.AI_SERVICE_PORT || '8000';
const host = process.env.AI_SERVICE_HOST || '127.0.0.1';
const args = ['-m', 'uvicorn', 'main:app', '--host', host, '--port', port, '--no-access-log'];
if (isDev) {
  args.push('--reload');
}

function portListenInfo(listenPort) {
  try {
    return execSync(`lsof -nP -iTCP:${listenPort} -sTCP:LISTEN`, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function probeHealth() {
  return new Promise((resolve) => {
    const req = http.get({ host, port: Number(port), path: '/health', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: body.slice(0, 300) }));
    });
    req.on('error', (err) => resolve({ error: err.code || err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

function occupantPids(info) {
  if (!info) return [];
  return [...new Set(info.split('\n').slice(1).map((line) => line.split(/\s+/)[1]).filter(Boolean))];
}

function waitUntilPortFree(listenPort) {
  for (let i = 0; i < 40; i += 1) {
    if (!portListenInfo(listenPort)) return true;
  }
  return !portListenInfo(listenPort);
}

(async () => {
  let occupant = portListenInfo(port);
  const pids = occupantPids(occupant);

  if (occupant) {
    const health = await probeHealth();
    const isOurs = health.statusCode === 200 && String(health.body || '').includes('Fit Stealer AI Service');
    if (!isOurs) {
      console.error(`[ai-service] Port ${port} is already in use:\n${occupant}`);
      process.exit(1);
    }
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        // Process may already have exited.
      }
    }
    waitUntilPortFree(port);
    occupant = portListenInfo(port);
    if (occupant) {
      console.error(`[ai-service] Port ${port} still in use after stopping leftover process:\n${occupant}`);
      process.exit(1);
    }
  }

  const child = spawn(pythonExecutable, args, { stdio: 'inherit', cwd: __dirname });

  child.on('exit', (code) => {
    process.exit(code || 0);
  });
})();
