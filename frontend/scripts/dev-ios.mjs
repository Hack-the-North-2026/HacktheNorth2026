import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import qrcode from 'qrcode-terminal';

const DEVICE = 'iPhone 17';
const PORT = 8081;
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

function debugLog(hypothesisId, location, message, data) {
  // #region agent log
  fetch('http://127.0.0.1:7786/ingest/14f230d3-70c9-4ad3-a18f-383a84fda265',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'deef38'},body:JSON.stringify({sessionId:'deef38',runId:'sim-pre',hypothesisId,location,message,data,timestamp:Date.now()})}).catch(()=>{});
  // #endregion
}

function run(command, args) {
  const started = Date.now();
  debugLog('A', 'dev-ios.mjs:run:start', `spawnSync ${command}`, { args });
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 8000 });
  debugLog('A', 'dev-ios.mjs:run:end', `spawnSync ${command} finished`, {
    args,
    status: result.status,
    signal: result.signal,
    errorCode: result.error?.code,
    errorMessage: result.error?.message,
    ms: Date.now() - started,
    stderr: String(result.stderr || '').slice(0, 400),
    stdout: String(result.stdout || '').slice(0, 200),
  });
  return result;
}

function bootSimulator() {
  if (process.platform !== 'darwin') {
    debugLog('A', 'dev-ios.mjs:bootSimulator:skip', 'Not darwin', { platform: process.platform });
    return;
  }
  debugLog('A', 'dev-ios.mjs:bootSimulator:start', 'Booting simulator', { device: DEVICE, platform: process.platform });
  run('xcrun', ['simctl', 'boot', DEVICE]);
  run('open', ['-a', 'Simulator']);
  const bootStatus = run('xcrun', ['simctl', 'list', 'devices', 'booted']);
  if (bootStatus.status !== 0 && bootStatus.error?.code !== 'ETIMEDOUT') {
    console.warn(bootStatus.stderr || 'Simulator boot status check failed.');
  }
  debugLog('A', 'dev-ios.mjs:bootSimulator:done', 'Finished bootSimulator', { status: bootStatus.status });
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

async function ensureExpoGo() {
  if (process.platform !== 'darwin') return;
  debugLog('C', 'dev-ios.mjs:ensureExpoGo:start', 'Checking Expo Go container', { bundleId: EXPO_GO_BUNDLE_ID });
  const check = run('xcrun', ['simctl', 'get_app_container', 'booted', EXPO_GO_BUNDLE_ID]);
  if (check.status === 0) {
    debugLog('C', 'dev-ios.mjs:ensureExpoGo:installed', 'Expo Go already installed', { status: check.status });
    return;
  }

  console.log('Expo Go is not installed on the simulator yet. Installing it now...');
  debugLog('C', 'dev-ios.mjs:ensureExpoGo:missing', 'Expo Go missing, installing', { status: check.status, stderr: String(check.stderr || '').slice(0, 300) });
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const { AppleDeviceManager } = req('expo/node_modules/@expo/cli/build/src/start/platforms/ios/AppleDeviceManager');
    const manager = await AppleDeviceManager.resolveAsync({ device: { name: DEVICE } });
    await manager.ensureExpoGoAsync('57.0.0');
    console.log('Expo Go installed successfully.');
    debugLog('C', 'dev-ios.mjs:ensureExpoGo:installedNow', 'Expo Go install succeeded', {});
  } catch (err) {
    console.warn(`Could not auto-install Expo Go: ${err.message}`);
    debugLog('C', 'dev-ios.mjs:ensureExpoGo:fail', 'Expo Go install failed', { error: err.message });
  }
}

async function openOnSimulator() {
  if (process.platform !== 'darwin') return;
  await ensureExpoGo();
  run('xcrun', ['simctl', 'launch', 'booted', EXPO_GO_BUNDLE_ID]);
  await delay(1500);

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const opened = run('xcrun', ['simctl', 'openurl', 'booted', EXPO_URL]);
    if (opened.status === 0) {
      console.log(`Opened ${EXPO_URL} on ${DEVICE}`);
      debugLog('D', 'dev-ios.mjs:openOnSimulator:opened', 'Opened Expo URL', { attempt, url: EXPO_URL });
      return;
    }
    console.warn(`Retry ${attempt}/6: could not open ${EXPO_URL} in the simulator`);
    debugLog('D', 'dev-ios.mjs:openOnSimulator:retry', 'openurl failed', { attempt, status: opened.status, stderr: String(opened.stderr || '').slice(0, 300) });
    await delay(3000);
  }

  console.warn(`Could not auto-open the iOS Simulator. In Expo Go, open ${EXPO_URL}`);
  debugLog('D', 'dev-ios.mjs:openOnSimulator:fail', 'Gave up opening Expo URL', { url: EXPO_URL });
}

debugLog('A', 'dev-ios.mjs:main', 'Script starting', { platform: process.platform, device: DEVICE, port: PORT });

const isWin = process.platform === 'win32';
const expoBin = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  isWin ? '../node_modules/.bin/expo.cmd' : '../node_modules/.bin/expo'
);

const localIp = getLocalIp();
const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL || (localIp !== '127.0.0.1' ? `http://${localIp}:4000` : 'http://127.0.0.1:4000');

console.log('Starting Expo on port 8081...');
const expo = spawn(expoBin, ['start', '--port', String(PORT)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    EXPO_PUBLIC_API_BASE_URL: apiBaseUrl,
    EXPO_NO_TELEMETRY: '1',
  },
  shell: isWin,
});

debugLog('B', 'dev-ios.mjs:expoSpawned', 'Spawned expo start', { pid: expo.pid, apiBaseUrl, runId: 'post-fix' });

bootSimulator();
debugLog('B', 'dev-ios.mjs:afterBoot', 'bootSimulator returned, spawning Expo', { expoBinExistsHint: 'next' });

waitForMetro()
  .then(async (ready) => {
    debugLog('B', 'dev-ios.mjs:metroReady', 'Metro wait finished', { ready });
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
    debugLog('E', 'dev-ios.mjs:openCatch', 'openOnSimulator threw', { error: error.message });
  });

expo.on('error', (error) => {
  debugLog('B', 'dev-ios.mjs:expoError', 'Expo spawn error', { error: error.message, code: error.code });
});

expo.on('exit', (code) => {
  debugLog('B', 'dev-ios.mjs:expoExit', 'Expo process exited', { code });
  process.exit(code ?? 0);
});


