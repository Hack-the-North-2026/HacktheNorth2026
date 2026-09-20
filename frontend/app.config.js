const fs = require('fs');
const path = require('path');

function loadRootEnv() {
  const envPath = path.resolve(__dirname, '../.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadRootEnv();

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN || '';
if (dsn && !process.env.EXPO_PUBLIC_SENTRY_DSN) {
  process.env.EXPO_PUBLIC_SENTRY_DSN = dsn;
}

const appJson = require('./app.json');
const plugins = (appJson.expo.plugins || []).filter((plugin) => {
  const name = Array.isArray(plugin) ? plugin[0] : plugin;
  return name !== '@sentry/react-native';
});

module.exports = {
  expo: {
    ...appJson.expo,
    extra: {
      ...(appJson.expo.extra || {}),
      sentryDsn: dsn,
    },
    plugins: [
      ...plugins,
      [
        '@sentry/react-native',
        {
          url: 'https://sentry.io/',
          organization: process.env.SENTRY_ORG || '',
          project: process.env.SENTRY_PROJECT || '',
        },
      ],
    ],
  },
};
