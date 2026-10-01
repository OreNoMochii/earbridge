// The app shares the protocol, the language list and the conversation logic with the
// web app, so Metro also watches those folders.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const root = path.resolve(__dirname, '..');

config.watchFolders = [...(config.watchFolders ?? []), path.join(root, 'shared'), path.join(root, 'client', 'src')];
// Packages used by those files (e.g. Babel helpers) come from the app's own node_modules.
config.resolver.nodeModulesPaths = [path.join(__dirname, 'node_modules')];

module.exports = config;
