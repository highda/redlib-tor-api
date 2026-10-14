'use strict';
// Media URL handling. Replaces Teddit's downloadAndSave(), which downloaded
// media to ./static and returned a local path; we return a path under /media/
// that this sidecar streams from Redlib's /raw/media/ passthrough instead.

/** Reddit media hosts Redlib's /raw/media/ passthrough accepts. */
const PROXIED_HOSTS = new Set([
  'i.redd.it',
  'v.redd.it',
  'preview.redd.it',
  'external-preview.redd.it',
  'a.thumbs.redditmedia.com',
  'b.thumbs.redditmedia.com',
  'emoji.redditmedia.com',
  'styles.redditmedia.com',
  'www.redditstatic.com',
]);

// Same as Teddit's downloadAndSave().
const INVALID_URLS = ['self', 'default', 'nsfw', 'image', 'spoiler', 'undefined', undefined, null, ''];
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogg'];

/** `https://i.redd.it/a.jpg?x=1` → `/media/i.redd.it/a.jpg?x=1`; other hosts unchanged. */
function mediaPath(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  if (!PROXIED_HOSTS.has(u.hostname)) return url;
  return `/media/${u.hostname}${u.pathname}${u.search}`;
}

function createDownloadAndSave(config) {
  return function downloadAndSave(url, file_prefix = '', gifmp4, _isYouTubeThumbnail) {
    if (INVALID_URLS.includes(url)) return Promise.resolve('self');
    let u;
    try {
      u = new URL(url);
    } catch {
      return Promise.resolve('');
    }
    if (!config.valid_media_domains.includes(u.hostname)) return Promise.resolve('');
    const pathname = u.pathname;
    const ext =
      gifmp4 || (!pathname.includes('.') && file_prefix !== 'flair_')
        ? 'mp4'
        : pathname.substring(pathname.lastIndexOf('.') + 1);
    if ((VIDEO_EXTENSIONS.includes(ext) || gifmp4) && !config.video_enabled) return Promise.resolve('');
    return Promise.resolve(mediaPath(url.replace(/&amp;/g, '&')));
  };
}

// Redlib in onion mode hands back onion hostnames; Teddit only knows clearnet
// ones (valid_media_domains, teddifyUrl). Map them back before processing.
const ONION_TO_CLEARNET = [
  [/((?:[a-z0-9-]+\.)?)reddittorjg6rue252oqsxryoxengawnmo46qy4kyii5wtqnwfj4ooad\.onion/g, '$1reddit.com'],
  [/((?:[a-z0-9-]+\.)?)redditdotzhmh3mao6r5i2j7speppwqkizwo7vksy3mbz5iz7rlhocyd\.onion/g, '$1redd.it'],
  [/((?:[a-z0-9-]+\.)?)reddit4hkhcpcf2mkmuotdlk3gknuzcatsw4f7dx7twdkwmtrt6ax4qd\.onion/g, '$1redditmedia.com'],
  [/((?:[a-z0-9-]+\.)?)reddittic34i5gtjcnm2fb7fv2eyop4vbxquuc36prnbs7d2kp3saoqd\.onion/g, '$1redditstatic.com'],
  [/((?:[a-z0-9-]+\.)?)redditfmzqdflud6azql7lq2help3hzypxqhoicbpyxyectczlhxd6qd\.onion/g, '$1reddithelp.com'],
];

function deonionize(text) {
  for (const [re, repl] of ONION_TO_CLEARNET) text = text.replace(re, repl);
  return text;
}

/**
 * Teddit-era media URLs that clients may still hold, mapped to /media/.
 * Returns the redirect target, or null if the request is not one of them.
 *   /pics/w:null_<file>          (teddifyUrl of i.redd.it images)
 *   /vids/<id>.mp4               (teddifyUrl of v.redd.it posts) → HLS playlist
 *   /<file>?teddit_proxy=<host>  (media links rewritten inside HTML bodies)
 */
function legacyMediaRedirect(pathname, searchParams) {
  const proxyHost = searchParams.get('teddit_proxy');
  if (proxyHost) {
    if (!PROXIED_HOSTS.has(proxyHost)) return null;
    const rest = new URLSearchParams(searchParams);
    rest.delete('teddit_proxy');
    const q = rest.toString();
    return `/media/${proxyHost}${pathname}${q ? `?${q}` : ''}`;
  }
  let m = pathname.match(/^\/pics\/w:null_([^/]+)$/);
  if (m) return `/media/i.redd.it/${m[1]}`;
  m = pathname.match(/^\/vids\/([A-Za-z0-9]+)\.mp4$/);
  if (m) return `/media/v.redd.it/${m[1]}/HLSPlaylist.m3u8`;
  return null;
}

module.exports = { PROXIED_HOSTS, mediaPath, createDownloadAndSave, deonionize, legacyMediaRedirect };
