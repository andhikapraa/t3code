const { withAppBuildGradle } = require("expo/config-plugins");

const FORK_SIGNING_CONFIG = `    def forkReleaseKeystorePath = System.getenv('T3CODE_ANDROID_KEYSTORE_PATH')
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
        if (forkReleaseKeystorePath) {
            forkRelease {
                storeFile file(forkReleaseKeystorePath)
                storePassword System.getenv('T3CODE_ANDROID_KEYSTORE_PASSWORD')
                keyAlias System.getenv('T3CODE_ANDROID_KEY_ALIAS')
                keyPassword System.getenv('T3CODE_ANDROID_KEY_PASSWORD')
            }
        }
    }`;

module.exports = function withForkAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "groovy") {
      throw new Error("Fork Android release signing requires a Groovy app build.gradle.");
    }

    const contents = nextConfig.modResults.contents;
    if (contents.includes("forkRelease")) {
      return nextConfig;
    }

    const signingConfigsPattern = /    signingConfigs \{[\s\S]*?\n    \}/u;
    if (!signingConfigsPattern.test(contents)) {
      throw new Error("Could not locate Android signingConfigs in generated build.gradle.");
    }

    let nextContents = contents.replace(signingConfigsPattern, FORK_SIGNING_CONFIG);
    const releaseStart = nextContents.indexOf("        release {");
    const releaseSigningConfig = nextContents.indexOf(
      "            signingConfig signingConfigs.debug",
      releaseStart,
    );
    if (releaseStart < 0 || releaseSigningConfig < 0) {
      throw new Error("Could not locate Android release signing config in generated build.gradle.");
    }

    nextContents = `${nextContents.slice(0, releaseSigningConfig)}            signingConfig forkReleaseKeystorePath ? signingConfigs.forkRelease : signingConfigs.debug${nextContents.slice(releaseSigningConfig + "            signingConfig signingConfigs.debug".length)}`;
    nextConfig.modResults.contents = nextContents;
    return nextConfig;
  });
};
