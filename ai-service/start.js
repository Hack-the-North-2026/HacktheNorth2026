const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match && !process.env[match[1]]) {
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
const args = ['-m', 'uvicorn', 'main:app', '--host', '0.0.0.0', '--port', port, '--no-access-log'];
if (isDev) {
  args.push('--reload');
}

const child = spawn(pythonExecutable, args, { stdio: 'inherit', cwd: __dirname });

child.on('exit', (code) => {
  process.exit(code || 0);
});
