import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import qrcode from 'qrcode-terminal';

const DEVICE = 'iPhone 17';
const PORT = 3000;
const EXPO_URL = `exp://127.0.0.1:${PORT}`;
const EXPO_GO_BUNDLE_ID = 'host.exp.Exponent';
const STATUS_URLS = [
  `http://127.0.0.1:${PORT}/status`,
  `http://localhost:${PORT}/status`,
  `http://[::1]:${PORT}/status`,
];

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function printQRCode() {
  const ip = getLocalIp();
  const lanExpoUrl = `exp://${ip}:${PORT}`;
  console.log('\n======================================================');
  console.log(`Scan this QR code in Expo Go app (iOS/Android):`);
  console.log(`URL: ${lanExpoUrl}`);
  console.log('======================================================');
  qrcode.generate(lanExpoUrl, { small: true });
  console.log('======================================================\n');
}

function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8' });
}

function bootSimulator() {
  if (process.platform !== 'darwin') {
    return;
  }
  run('xcrun', ['simctl', 'boot', DEVICE]);
  run('open', ['-a', 'Simulator']);
  const bootStatus = run('xcrun', ['simctl', 'bootstatus', 'booted', '-b']);
  if (bootStatus.status !== 0) {
    console.warn(bootStatus.stderr || 'Simulator boot status check failed.');
  }
}

async function metroIsRunning() {
  for (const url of STATUS_URLS) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      const body = await response.text();
      if (response.ok && body.includes('packager-status:running')) {
        return true;
      }
    } catch {
      // Try the next loopback address.
    }
  }
  return false;
}

async function waitForMetro() {
  for (let i = 0; i < 90; i += 1) {
    if (await metroIsRunning()) {
      return true;
    }
    await delay(1000);
  }
  return false;
}

async function openOnSimulator() {
  if (process.platform !== 'darwin') return;
  const launch = run('xcrun', ['simctl', 'launch', 'booted', EXPO_GO_BUNDLE_ID]);
  if (launch.status !== 0) {
    console.warn(
      'Expo Go is not installed on the simulator yet. It will be installed the next time Expo can reach the device.',
    );
    console.warn(launch.stderr?.trim());
  }
  await delay(2500);

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const opened = run('xcrun', ['simctl', 'openurl', 'booted', EXPO_URL]);
    if (opened.status === 0) {
      console.log(`Opened ${EXPO_URL} on ${DEVICE}`);
      return;
    }
    console.warn(`Retry ${attempt}/6: could not open ${EXPO_URL} in the simulator`);
    await delay(3000);
  }

  console.warn(`Could not auto-open the iOS Simulator. In Expo Go, open ${EXPO_URL}`);
}

bootSimulator();

const isWin = process.platform === 'win32';
const expoBin = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  isWin ? '../node_modules/.bin/expo.cmd' : '../node_modules/.bin/expo'
);

const expo = spawn(expoBin, ['start', '--port', String(PORT)], {
  stdio: 'inherit',
  env: process.env,
  shell: isWin,
});

waitForMetro()
  .then(async (ready) => {
    if (!ready) {
      console.warn('Metro did not become ready; skipping simulator open.');
      return;
    }
    printQRCode();
    if (process.platform === 'darwin') {
      await openOnSimulator();
    }
  })
  .catch((error) => {
    console.warn(`Could not open iOS Simulator: ${error.message}`);
  });

expo.on('exit', (code) => {
  process.exit(code ?? 0);
});


