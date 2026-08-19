const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

const baseResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Workaround for Expo SDK 57 + Expo Go crash (expo/expo#48390):
  // react-native-worklets 0.10.1 triggers a SIGSEGV in Expo Go on startup
  // even when the app never imports it directly (pulled in via @expo/ui).
  // This app uses neither reanimated nor worklets, so stub it out.
  if (moduleName === "react-native-worklets") {
    return { type: "empty" };
  }
  return baseResolveRequest
    ? baseResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;