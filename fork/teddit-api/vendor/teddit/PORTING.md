# Vendored Teddit code

Source: <https://codeberg.org/teddit/teddit>, commit
`3d5fb4bb92f1a214f4990289a7a6e003d1bb2477`. License: AGPL-3.0 (see `LICENSE`, copied
unchanged). The upstream files carry no per-file license headers.

Files are copied byte for byte unless listed below. They stay CommonJS and keep
Teddit's global-function wiring; `src/teddit.cjs` loads them the way Teddit's `app.js`
did.

| File | Change |
|---|---|
| `config.js` | Copy of upstream `config.js.template`, unchanged. Values come from env vars; `src/teddit.cjs` sets `DOMAIN`, `HTTPS_ENABLED` and `API_FORCE_HTTPS` from `PUBLIC_BASE_URL` before loading it. |
| `inc/redis.js` | Removed `require('redis')`; always uses Teddit's own built-in stub (Teddit's `REDIS_ENABLED=false` path). |
| `package.json` | Added (`{"type": "commonjs"}`) so Node treats these files as CommonJS inside an ESM package. |

Not vendored: `inc/downloadAndSave.js` (replaced by `src/media.cjs`, which keeps its
return-value contract but returns `/media/...` URLs instead of downloading to disk),
`inc/initRedditApi.js`, `inc/processMoreComments.js`, `routes/`, `views/`, `app.js`.

`test/differential.test.js` replays every case against an untouched checkout of the
same commit and requires identical output.
