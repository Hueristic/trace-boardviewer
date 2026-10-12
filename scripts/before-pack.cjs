'use strict';

// electron-builder hook (package.json build.beforePack): every packaging route runs it, so a stale renderer build cannot be packed.
const path = require('path');
const { checkDistFresh } = require('./dist-freshness.cjs');

module.exports = async function beforePack() {
  checkDistFresh(path.resolve(__dirname, '..'));
};
