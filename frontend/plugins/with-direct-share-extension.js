const fs = require('fs');
const path = require('path');
const plistModule = require('@expo/plist');
const plist = plistModule.default || plistModule;
const {
  createRunOncePlugin,
  withDangerousMod,
  withEntitlementsPlist,
  withPlugins,
} = require('@expo/config-plugins');

const sharingRoot = path.dirname(require.resolve('expo-sharing/package.json'));
const { withShareExtensionXcodeProject } = require(path.join(
  sharingRoot,
  'plugin/build/ios/withShareExtensionXcodeProject.js',
));

const TARGET_NAME = 'FitStealerShare';

function withExtensionFiles(config, props) {
  return withDangerousMod(config, [
    'ios',
    async (modConfig) => {
      const targetPath = path.join(modConfig.modRequest.platformProjectRoot, TARGET_NAME);
      fs.mkdirSync(targetPath, { recursive: true });

      const configuredUrl =
        process.env.EXPO_PUBLIC_API_BASE_URL || props.apiBaseUrl || 'https://replace-with-your-backend.example';
      const swiftTemplate = fs.readFileSync(
        path.join(modConfig.modRequest.projectRoot, 'targets/share-extension/ShareViewController.swift'),
        'utf8',
      );
      fs.writeFileSync(
        path.join(targetPath, 'ShareViewController.swift'),
        swiftTemplate.replaceAll('__API_BASE_URL__', configuredUrl.replace(/\/$/, '')),
      );

      fs.writeFileSync(
        path.join(targetPath, `${TARGET_NAME}.entitlements`),
        plist.build({}),
      );
      fs.writeFileSync(
        path.join(targetPath, 'Info.plist'),
        plist.build({
          CFBundleDevelopmentRegion: '$(DEVELOPMENT_LANGUAGE)',
          CFBundleDisplayName: 'Fit Stealer',
          CFBundleExecutable: '$(EXECUTABLE_NAME)',
          CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
          CFBundleInfoDictionaryVersion: '6.0',
          CFBundleName: '$(PRODUCT_NAME)',
          CFBundlePackageType: 'XPC!',
          CFBundleShortVersionString: '$(MARKETING_VERSION)',
          CFBundleVersion: '$(CURRENT_PROJECT_VERSION)',
          NSExtension: {
            NSExtensionAttributes: {
              NSExtensionActivationRule: {
                NSExtensionActivationSupportsImageWithMaxCount: 1,
              },
            },
            NSExtensionPointIdentifier: 'com.apple.share-services',
            NSExtensionPrincipalClass: '$(PRODUCT_MODULE_NAME).ShareViewController',
          },
        }),
      );

      Object.assign(props.files, {
        swiftFiles: ['ShareViewController.swift'],
        // The Xcode helper always adds these two files itself.
        entitlementFiles: [],
        plistFiles: [],
        assetDirectories: [],
        intentFiles: [],
        otherFiles: [],
        sharedFiles: null,
      });
      return modConfig;
    },
  ]);
}

function withDirectShareExtension(config, options = {}) {
  const files = {};
  const bundleIdentifier = config.ios?.bundleIdentifier;
  if (!bundleIdentifier) {
    throw new Error('with-direct-share-extension requires ios.bundleIdentifier.');
  }
  const extensionBundleIdentifier = `${bundleIdentifier}.ShareExtension`;

  config.extra = {
    ...config.extra,
    eas: {
      ...config.extra?.eas,
      build: {
        ...config.extra?.eas?.build,
        experimental: {
          ...config.extra?.eas?.build?.experimental,
          ios: {
            ...config.extra?.eas?.build?.experimental?.ios,
            appExtensions: [
              ...(config.extra?.eas?.build?.experimental?.ios?.appExtensions || []).filter(
                (extension) => extension.targetName !== TARGET_NAME,
              ),
              {
                targetName: TARGET_NAME,
                bundleIdentifier: extensionBundleIdentifier,
                entitlements: {},
              },
            ],
          },
        },
      },
    },
  };

  config = withEntitlementsPlist(config, (entitlementsConfig) => {
    // This flow uses local notifications only. expo-notifications adds the
    // APNs entitlement by default, which a free Personal Team cannot sign.
    delete entitlementsConfig.modResults['aps-environment'];
    return entitlementsConfig;
  });

  return withPlugins(config, [
    [withExtensionFiles, { ...options, files }],
    [withShareExtensionXcodeProject, {
      targetName: TARGET_NAME,
      bundleIdentifier: extensionBundleIdentifier,
      deploymentTarget: '16.4',
      shareExtensionFiles: files,
    }],
  ]);
}

module.exports = createRunOncePlugin(
  withDirectShareExtension,
  'with-direct-share-extension',
  '1.0.0',
);
