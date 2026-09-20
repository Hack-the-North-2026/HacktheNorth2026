/**
 * app.plugin.js — Expo Config Plugin for the Android Screen Identify module.
 *
 * Runs during `expo prebuild` and modifies the generated Android project:
 *
 *  1. Injects SYSTEM_ALERT_WINDOW + accessibility permissions into AndroidManifest.xml
 *  2. Registers FitStealerAccessibilityService in AndroidManifest.xml
 *  3. Copies the Kotlin source + XML resources into android/app/src/main/
 *  4. Injects a BuildConfig field (FIT_STEALER_API_URL) from EXPO_PUBLIC_API_BASE_URL
 *  5. Adds a resValue for the accessibility_service_description string
 */

const {
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
} = require('@expo/config-plugins');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deeply find or create an element inside an AndroidManifest node list.
 * @param {object[]} nodeList  Array of XML nodes
 * @param {string}   tag       XML tag name to look for / create
 * @param {object}   [attrs]   Attributes to set on the found/created node
 */
function findOrCreate(nodeList, tag, attrs = {}) {
  let node = nodeList.find((n) => n.$?.['android:name'] === attrs['android:name']);
  if (!node) {
    node = { $: {}, _: [] };
    nodeList.push(node);
  }
  Object.assign(node.$, { [tag]: tag, ...attrs });
  return node;
}

// ---------------------------------------------------------------------------
// Step 1 — AndroidManifest.xml modifications
// ---------------------------------------------------------------------------
function withAndroidOverlayManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    const app = manifest.manifest.application[0];

    // --- Permissions ---
    const existingPerms = manifest.manifest['uses-permission'] || [];
    manifest.manifest['uses-permission'] = existingPerms;

    const requiredPerms = [
      // Draw-over-other-apps: needed for TYPE_ACCESSIBILITY_OVERLAY fallback
      // and for showing the bubble while the service bootstraps.
      'android.permission.SYSTEM_ALERT_WINDOW',
      // Bind the accessibility service (enforced by Android automatically;
      // declaring it here satisfies lint / Play Store review).
      'android.permission.BIND_ACCESSIBILITY_SERVICE',
      // Post status notification (Android 13+ / API 33 requirement).
      'android.permission.POST_NOTIFICATIONS',
      // Required for Screen Recording
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
    ];

    for (const perm of requiredPerms) {
      const already = existingPerms.some((p) => p.$?.['android:name'] === perm);
      if (!already) {
        existingPerms.push({ $: { 'android:name': perm } });
      }
    }

    // --- Service declaration ---
    const services = app.service || [];
    app.service = services;

    const serviceName = 'com.fitstealer.overlay.FitStealerAccessibilityService';
    const alreadyDeclared = services.some((s) => s.$?.['android:name'] === serviceName);

    if (!alreadyDeclared) {
      services.push({
        $: {
          'android:name': serviceName,
          'android:exported': 'true',
          'android:label': 'Fit Stealer',
          // BIND_ACCESSIBILITY_SERVICE prevents 3rd-party apps from binding —
          // Android enforces this; declaring it here locks it down explicitly.
          'android:permission': 'android.permission.BIND_ACCESSIBILITY_SERVICE',
        },
        // intent-filter that Android uses to discover AccessibilityServices.
        'intent-filter': [
          {
            action: [{ $: { 'android:name': 'android.accessibilityservice.AccessibilityService' } }],
          },
        ],
        // Metadata pointing to the accessibility_service_config.xml descriptor.
        'meta-data': [
          {
            $: {
              'android:name': 'android.accessibilityservice',
              'android:resource': '@xml/accessibility_service_config',
            },
          },
        ],
      });
    }

    const recordServiceName = 'com.fitstealer.overlay.ScreenRecordService';
    const alreadyRecordDeclared = services.some((s) => s.$?.['android:name'] === recordServiceName);
    if (!alreadyRecordDeclared) {
      services.push({
        $: {
          'android:name': recordServiceName,
          'android:exported': 'false',
          'android:foregroundServiceType': 'mediaProjection',
        }
      });
    }

    // --- Activity declaration ---
    const activities = app.activity || [];
    app.activity = activities;

    const activityName = 'com.fitstealer.overlay.ScreenRecordConsentActivity';
    const alreadyActivityDeclared = activities.some((a) => a.$?.['android:name'] === activityName);
    if (!alreadyActivityDeclared) {
      activities.push({
        $: {
          'android:name': activityName,
          'android:exported': 'false',
          'android:theme': '@android:style/Theme.Translucent.NoTitleBar',
          'android:excludeFromRecents': 'true',
          'android:taskAffinity': '',
        }
      });
    }

    return cfg;
  });
}

// ---------------------------------------------------------------------------
// Step 2 — BuildConfig field (API URL) + resValue string
// ---------------------------------------------------------------------------
function withBuildConfigApiUrl(config) {
  return withAppBuildGradle(config, (cfg) => {
    const apiUrl =
      process.env.EXPO_PUBLIC_API_BASE_URL ||
      // Android emulator routes 10.0.2.2 → the dev machine's localhost.
      'http://10.0.2.2:4000';

    const buildConfigLine = `        buildConfigField "String", "FIT_STEALER_API_URL", "\\"${apiUrl}\\""`;
    const resValueLine = `        resValue "string", "fit_stealer_api_url", "${apiUrl}"\n        resValue "string", "accessibility_service_description", "Fit Stealer Overlay - tap bubble to identify clothing"` ;

    // withAppBuildGradle gives modResults as { path: string; contents: string }.
    // Operate on the .contents string, not the wrapper object.
    if (!cfg.modResults.contents.includes('FIT_STEALER_API_URL')) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /defaultConfig\s*\{/,
        `defaultConfig {\n${buildConfigLine}\n${resValueLine}`,
      );
    }

    return cfg;
  });
}

// ---------------------------------------------------------------------------
// Step 3 — Copy native source files into the Android project
// ---------------------------------------------------------------------------
function withCopyNativeSources(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot;
      const androidRoot = path.join(projectRoot, 'android', 'app', 'src', 'main');
      const moduleRoot = path.join(projectRoot, 'modules', 'android-screen-identify', 'android', 'src', 'main');

      /**
       * Recursively copy everything from src → dest.
       * Only overwrites if the source file is newer (simple mtime check).
       */
      function copyRecursive(src, dest) {
        if (!fs.existsSync(src)) return;
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
          fs.mkdirSync(dest, { recursive: true });
          for (const child of fs.readdirSync(src)) {
            copyRecursive(path.join(src, child), path.join(dest, child));
          }
        } else {
          const destExists = fs.existsSync(dest);
          if (!destExists || fs.statSync(src).mtimeMs > fs.statSync(dest).mtimeMs) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
            console.log(`[android-screen-identify] Copied: ${path.relative(projectRoot, dest)}`);
          }
        }
      }

      copyRecursive(moduleRoot, androidRoot);
      return cfg;
    },
  ]);
}

// ---------------------------------------------------------------------------
// Plugin entry point — compose all steps
// ---------------------------------------------------------------------------
const withAndroidScreenIdentify = (config) => {
  config = withAndroidOverlayManifest(config);
  config = withBuildConfigApiUrl(config);
  config = withCopyNativeSources(config);
  return config;
};

module.exports = withAndroidScreenIdentify;
