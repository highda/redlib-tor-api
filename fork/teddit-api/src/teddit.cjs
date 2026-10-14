'use strict';
// Loads a Teddit source tree (our vendored copy, or an untouched checkout for
// the differential test) and returns its API handlers.
//
// Teddit's modules communicate through globals: commons.js, processPostMedia.js,
// compilePostComments.js and the teddit_api handlers assign their functions to
// `this` (the global object) when called. We reproduce app.js's wiring here,
// minus Express, Redis and the on-disk media cache.

const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const { createDownloadAndSave } = require('./media.cjs');

const VENDOR_DIR = path.join(__dirname, '..', 'vendor', 'teddit');

let loaded = null;

function installHooks(root) {
  const vendorConfig = path.join(VENDOR_DIR, 'config.js');
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    // An untouched checkout only ships config.js.template; use the vendored copy.
    if (parent && parent.filename && parent.filename.startsWith(root) && /(^|\/)config$/.test(request)) {
      const candidate = path.resolve(path.dirname(parent.filename), request + '.js');
      if (!fs.existsSync(candidate)) return vendorConfig;
    }
    return origResolve.call(this, request, parent, ...rest);
  };
  const origLoad = Module._load;
  Module._load = function (request, parent, ...rest) {
    // An untouched checkout's redis.js requires the `redis` package.
    if (request === 'redis') {
      const stub = { get: (_, cb) => cb(null, null), setex: (_, _1, _2, cb) => cb(null), on: () => {} };
      return { createClient: () => stub };
    }
    return origLoad.call(this, request, parent, ...rest);
  };
}

/**
 * @param {string} [root] Teddit tree to load. Defaults to the vendored copy.
 * @param {{ publicBaseUrl?: string }} [opts] Public origin, e.g. https://example.org.
 * Only one tree can be loaded per process (Teddit uses globals).
 */
function loadTeddit(root = VENDOR_DIR, opts = {}) {
  root = path.resolve(root);
  if (loaded) {
    if (loaded.root !== root) throw new Error(`Teddit already loaded from ${loaded.root}`);
    return loaded.api;
  }
  installHooks(root);

  // Teddit's config.js reads these at require time.
  const base = new URL(opts.publicBaseUrl || process.env.PUBLIC_BASE_URL || 'http://localhost:8080');
  const https = base.protocol === 'https:' ? 'true' : 'false';
  process.env.DOMAIN = base.host;
  process.env.HTTPS_ENABLED = https;
  process.env.API_FORCE_HTTPS = https;

  const config = require(path.join(VENDOR_DIR, 'config.js'));
  // Teddit's commons.js only uses `request` for downloadFile(), which only the
  // replaced downloadAndSave() calls.
  const requestStub = (_url, _opts, cb) => cb(new Error('downloads disabled'), null, null);
  require(path.join(root, 'inc', 'commons.js'))(requestStub, fs);
  global.downloadAndSave = createDownloadAndSave(config);

  require(path.join(root, 'inc', 'teddit_api', 'handleSubreddit.js'))();
  require(path.join(root, 'inc', 'teddit_api', 'handlePost.js'))();
  require(path.join(root, 'inc', 'teddit_api', 'handleUser.js'))();

  const api = {
    config,
    handleSubreddit: global.handleTedditApiSubreddit,
    handleSubredditAbout: global.handleTedditApiSubredditAbout,
    handleSubredditSearch: global.handleTedditApiSubredditSearch,
    handleSubredditsExplore: global.handleTedditApiSubredditsExplore,
    handlePost: global.handleTedditApiPost,
    handleUser: global.handleTedditApiUser,
  };
  loaded = { root, api };
  return api;
}

module.exports = { loadTeddit, VENDOR_DIR };
