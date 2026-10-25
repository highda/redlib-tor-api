# Third-party code

| Component | Source | License | Where |
|---|---|---|---|
| Redlib | <https://github.com/redlib-org/redlib> | AGPL-3.0 | Repository root (fork parent) |
| Tor onion routing, fingerprint gate, DASH/CMAF support | baalajimaestro, <https://git.ptr.moe/baalajimaestro/redlib>, commit `3f03e10eb230524c0fdce331c9075a181f6229c1` | AGPL-3.0 | Cherry-picked commit, author preserved |
| Picked fixes | Nachtalb/redlib, polak14/redlib, mrnamwen/redlib, LucifersCircle/redlib, SpikeHD/redlib-ex, mitchross/redlib, alexbudisan/redlib and unmerged redlib-org pull requests (#521, #560, #568, #596, #603); authors listed in `fork/README.md`, "Picked fixes" | AGPL-3.0 | Cherry-picked and ported commits, authors preserved |
| Ideas from other forks | LucifersCircle/redlib, agandhi4/redlib, alexbudisan/redlib, perennialtech/redlib; listed in `fork/README.md`, "Ideas from other forks" | AGPL-3.0 | Reimplemented; `credential_rejected` ported from LucifersCircle `ed20ceb` |
| Teddit API processors and handlers | <https://codeberg.org/teddit/teddit>, commit `3d5fb4bb92f1a214f4990289a7a6e003d1bb2477` | AGPL-3.0 | `fork/teddit-api/vendor/teddit/` (edits listed in `PORTING.md`) |
| Recorded Reddit API responses | reddit.com, fetched through Redlib | Reddit content, used as test data | `fork/teddit-api/test/fixtures/` |
