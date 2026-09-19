const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let pythonExecutable = 'python';

const winVenvPython = path.join(__dirname, 'venv', 'Scripts', 'python.exe');
const posixVenvPython = path.join(__dirname, 'venv', 'bin', 'python');

if (fs.existsSync(winVenvPython)) {
  pythonExecutable = winVenvPython;
} else if (fs.existsSync(posixVenvPython)) {
  pythonExecutable = posixVenvPython;
}

const isDev = process.argv.includes('--dev');
const args = ['-m', 'uvicorn', 'main:app', '--host', '0.0.0.0', '--port', '8000'];
if (isDev) {
  args.push('--reload');
}

const child = spawn(pythonExecutable, args, { stdio: 'inherit' });

child.on('exit', (code) => {
  process.exit(code || 0);
});
