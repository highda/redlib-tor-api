//! `/raw/*` route: passes Reddit's JSON through for the redlib-tor-api
//! Teddit-compatible sidecar (see `fork/`).
//!
//! Disabled unless `REDLIB_RAW_TOKEN` is set. Every request needs a matching
//! `X-Raw-Token` header, and only an allowlist of read-only listing paths is
//! forwarded. Anything else gets a 404 that looks like a missing route.
//!
//! `/raw/media/{host}/{path}` streams media from an allowlisted Reddit media
//! host through Redlib's own proxy, so API clients never meet the browser
//! fingerprint gate.

use crate::client::{json, proxy};
use hyper::{Body, Request, Response};
use serde_json::{json as json_value, Value};
use std::sync::LazyLock;

static RAW_TOKEN: LazyLock<Option<String>> = LazyLock::new(|| std::env::var("REDLIB_RAW_TOKEN").ok().filter(|t| !t.is_empty()));

/// Query parameters forwarded to Reddit. Everything else is dropped.
const QUERY_ALLOWLIST: &[&str] = &[
	"after",
	"before",
	"context",
	"count",
	"cursor",
	"depth",
	"include_over_18",
	"limit",
	"q",
	"raw_json",
	"restrict_sr",
	"sort",
	"sr_detail",
	"t",
	"type",
];

const SORTS: &[&str] = &["hot", "new", "top", "rising", "controversial", "best", "gilded"];
const USER_LISTINGS: &[&str] = &["about", "overview", "submitted", "comments"];
const SUBREDDITS_LISTINGS: &[&str] = &["search", "popular", "new", "default"];
const MEDIA_HOSTS: &[&str] = &[
	"i.redd.it",
	"v.redd.it",
	"preview.redd.it",
	"external-preview.redd.it",
	"a.thumbs.redditmedia.com",
	"b.thumbs.redditmedia.com",
	"emoji.redditmedia.com",
	"styles.redditmedia.com",
	"www.redditstatic.com",
];

pub async fn handler(req: Request<Body>) -> Result<Response<Body>, String> {
	let provided = req.headers().get("x-raw-token").and_then(|v| v.to_str().ok());
	if !authorized(RAW_TOKEN.as_deref(), provided) {
		return Ok(not_found());
	}

	let path = req.uri().path().strip_prefix("/raw").unwrap_or_default();
	if let Some(media) = path.strip_prefix("/media/") {
		return match media_url(media) {
			Some(url) => proxy(req, &url).await,
			None => Ok(not_found()),
		};
	}
	let Some(reddit_path) = reddit_path(path) else {
		return Ok(not_found());
	};
	let query = filter_query(req.uri().query().unwrap_or_default());
	let target = if query.is_empty() { reddit_path } else { format!("{reddit_path}?{query}") };

	// Reddit blocks the comments JSON for anonymous clients, so threads come
	// from GraphQL in the same two-Listing shape. That builds raw strings; give
	// clients that did not ask for raw_json=1 Reddit's legacy escaping back.
	let result = if crate::gql::parse_path(&target).is_some() {
		let raw = query.split('&').any(|pair| pair == "raw_json=1");
		crate::gql::thread(target, true)
			.await
			.map(crate::gql::for_api_clients)
			.map(|value| if raw { value } else { legacy_escape(value) })
	} else {
		json(target, true).await
	};

	Ok(match result {
		Ok(value) => json_response(200, &value),
		Err(msg) => {
			let status = error_status(&msg);
			let mut response = json_response(status, &json_value!({ "error": msg, "status": status }));
			if let Some(seconds) = crate::utils::retry_after(&msg, status) {
				response.headers_mut().insert("retry-after", seconds.into());
			}
			response
		}
	})
}

/// Reddit's JSON without raw_json=1 escapes `&`, `<` and `>` in every string.
fn legacy_escape(value: Value) -> Value {
	match value {
		Value::String(s) => Value::String(s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")),
		Value::Array(items) => Value::Array(items.into_iter().map(legacy_escape).collect()),
		Value::Object(map) => Value::Object(map.into_iter().map(|(k, v)| (k, legacy_escape(v))).collect()),
		other => other,
	}
}

/// Constant-time token check. `None` expected means the route is disabled.
fn authorized(expected: Option<&str>, provided: Option<&str>) -> bool {
	let (Some(expected), Some(provided)) = (expected, provided) else {
		return false;
	};
	let (a, b) = (expected.as_bytes(), provided.as_bytes());
	let mut diff = a.len() ^ b.len();
	for i in 0..a.len().max(b.len()) {
		diff |= usize::from(a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0));
	}
	diff == 0
}

/// Maps a `/raw`-relative path to the Reddit API path (with `.json`), or
/// `None` if it is not on the allowlist.
fn reddit_path(path: &str) -> Option<String> {
	let trimmed = path.trim_end_matches('/');
	let trimmed = trimmed.strip_suffix(".json").unwrap_or(trimmed);
	let segs: Vec<&str> = trimmed.split('/').skip(1).collect();
	let segs: &[&str] = if segs == [""] { &[] } else { &segs };
	if segs.iter().any(|s| s.is_empty()) {
		return None;
	}

	let ok = match segs {
		// Front page
		[] => true,
		[one] => SORTS.contains(one) || *one == "search" || *one == "subreddits",
		// Subreddit listings, about, search
		["r", sub] => is_sub(sub),
		["r", sub, rest] => is_sub(sub) && (SORTS.contains(rest) || *rest == "about" || *rest == "search"),
		// Comment threads
		["r", sub, "comments", id, tail @ ..] => is_sub(sub) && is_id(id) && is_thread_tail(tail),
		["comments", id, tail @ ..] => is_id(id) && is_thread_tail(tail),
		// Users
		["user", name] => is_user(name),
		["user", name, listing] => is_user(name) && USER_LISTINGS.contains(listing),
		// Subreddit discovery
		["subreddits", listing] => SUBREDDITS_LISTINGS.contains(listing),
		["users", "search"] => true,
		_ => false,
	};

	// Reddit's front page is `/hot` when no sort is given.
	ok.then(|| {
		if segs.is_empty() {
			"/hot.json".to_string()
		} else {
			// Reddit reads a literal `+` in `/r/a+b` as a space and answers with
			// r/popular; Redlib's own pages encode it too.
			let segs: Vec<String> = segs
				.iter()
				.enumerate()
				.map(|(i, seg)| if i == 1 && segs[0] == "r" { seg.replace('+', "%2B") } else { (*seg).to_string() })
				.collect();
			format!("/{}.json", segs.join("/"))
		}
	})
}

/// `{host}/{path}` to an upstream media URL, if the host is allowlisted.
fn media_url(media: &str) -> Option<String> {
	let (host, path) = media.split_once('/')?;
	let path_ok =
		!path.is_empty() && path.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != "..") && path.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./%:".contains(&b));
	(MEDIA_HOSTS.contains(&host) && path_ok).then(|| format!("https://{host}/{path}"))
}

fn is_sub(s: &str) -> bool {
	s.len() <= 512 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'+')
}

fn is_user(s: &str) -> bool {
	s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn is_id(s: &str) -> bool {
	s.len() <= 16 && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Optional `/{slug}` and `/{slug}/{comment_id}` after a post id.
fn is_thread_tail(tail: &[&str]) -> bool {
	let is_slug = |s: &str| s.len() <= 512 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-%".contains(&b));
	match tail {
		[] => true,
		[slug] => is_slug(slug),
		[slug, comment] => is_slug(slug) && is_id(comment),
		_ => false,
	}
}

fn filter_query(query: &str) -> String {
	query
		.split('&')
		.filter(|pair| {
			let key = pair.split('=').next().unwrap_or_default();
			QUERY_ALLOWLIST.contains(&key)
		})
		.collect::<Vec<_>>()
		.join("&")
}

/// Best-effort HTTP status for an error string from `client::json`.
fn error_status(msg: &str) -> u16 {
	crate::utils::reddit_error_status(msg).unwrap_or(502)
}

fn json_response(status: u16, value: &serde_json::Value) -> Response<Body> {
	Response::builder()
		.status(status)
		.header("content-type", "application/json")
		.header("cache-control", "no-store")
		.body(value.to_string().into())
		.unwrap_or_default()
}

fn not_found() -> Response<Body> {
	Response::builder()
		.status(404)
		.header("content-type", "text/plain")
		.body("Not found".into())
		.unwrap_or_default()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn token_gate() {
		assert!(!authorized(None, None));
		assert!(!authorized(None, Some("secret")));
		assert!(!authorized(Some("secret"), None));
		assert!(!authorized(Some("secret"), Some("")));
		assert!(!authorized(Some("secret"), Some("secreT")));
		assert!(!authorized(Some("secret"), Some("secret2")));
		assert!(!authorized(Some("secret"), Some("secre")));
		assert!(authorized(Some("secret"), Some("secret")));
	}

	#[tokio::test]
	async fn disabled_without_token() {
		// REDLIB_RAW_TOKEN is not set in the test environment.
		let req = Request::builder().uri("/raw/r/rust/hot.json").header("x-raw-token", "x").body(Body::empty()).unwrap();
		assert_eq!(handler(req).await.unwrap().status(), 404);
	}

	#[test]
	fn allowlist_accepts() {
		let ok = [
			("", "/hot.json"),
			("/", "/hot.json"),
			("/hot", "/hot.json"),
			("/top.json", "/top.json"),
			("/r/rust", "/r/rust.json"),
			("/r/rust/hot.json", "/r/rust/hot.json"),
			("/r/rust+linux/new", "/r/rust%2Blinux/new.json"),
			("/r/rust+linux", "/r/rust%2Blinux.json"),
			("/r/rust/about", "/r/rust/about.json"),
			("/r/rust/search.json", "/r/rust/search.json"),
			("/r/rust/comments/abc123", "/r/rust/comments/abc123.json"),
			("/r/rust/comments/abc123/some_title/", "/r/rust/comments/abc123/some_title.json"),
			("/r/rust/comments/abc123/some_title/def456", "/r/rust/comments/abc123/some_title/def456.json"),
			("/comments/abc123", "/comments/abc123.json"),
			("/user/spez/about.json", "/user/spez/about.json"),
			("/user/some-user_1/submitted", "/user/some-user_1/submitted.json"),
			("/user/spez/comments", "/user/spez/comments.json"),
			("/user/spez/overview", "/user/spez/overview.json"),
			("/search.json", "/search.json"),
			("/subreddits/search", "/subreddits/search.json"),
			("/users/search", "/users/search.json"),
		];
		for (input, expected) in ok {
			assert_eq!(reddit_path(input).as_deref(), Some(expected), "{input}");
		}
	}

	#[test]
	fn allowlist_rejects() {
		let bad = [
			"/api/v1/me",
			"/api/morechildren",
			"/r/rust/wiki",
			"/r/rust/about/moderators",
			"/r/rust/submit",
			"/r/rust/sideways",
			"/r/../api",
			"/r/rust/comments/abc/x/y/z",
			"/r/ru.st",
			"/r/rust/comments/a.b",
			"/user/spez/saved",
			"/user/spez/upvoted",
			"/subreddits/mine",
			"/prefs",
			"//r/rust",
			"/r//hot",
		];
		for input in bad {
			assert_eq!(reddit_path(input), None, "{input}");
		}
	}

	#[test]
	fn media_allowlist() {
		assert_eq!(media_url("i.redd.it/abc.jpg").as_deref(), Some("https://i.redd.it/abc.jpg"));
		assert_eq!(media_url("v.redd.it/xyz/DASH_480.mp4").as_deref(), Some("https://v.redd.it/xyz/DASH_480.mp4"));
		assert_eq!(media_url("emoji.redditmedia.com/a1/b_2").as_deref(), Some("https://emoji.redditmedia.com/a1/b_2"));
		assert_eq!(media_url("evil.com/x.jpg"), None);
		assert_eq!(media_url("i.redd.it"), None);
		assert_eq!(media_url("i.redd.it/"), None);
		assert_eq!(media_url("i.redd.it/../x"), None);
		assert_eq!(media_url("i.redd.it/a//b"), None);
		assert_eq!(media_url("i.redd.it/{path}"), None);
		assert_eq!(media_url("i.redd.it@evil.com/x"), None);
	}

	#[test]
	fn query_passthrough() {
		assert_eq!(filter_query(""), "");
		assert_eq!(
			filter_query("limit=10&after=t3_x&before=t3_y&t=week&sort=top&q=rust%20lang&restrict_sr=on&raw_json=1"),
			"limit=10&after=t3_x&before=t3_y&t=week&sort=top&q=rust%20lang&restrict_sr=on&raw_json=1"
		);
		assert_eq!(filter_query("api&type=json&limit=5&token=x&redirect=evil"), "type=json&limit=5");
	}

	#[test]
	fn legacy_escape_matches_reddits_raw_json_0() {
		let value = json_value!({ "body": "a < b && c > d", "n": 1, "replies": [{ "body_html": "<p>&#39;</p>" }] });
		assert_eq!(
			legacy_escape(value),
			json_value!({ "body": "a &lt; b &amp;&amp; c &gt; d", "n": 1, "replies": [{ "body_html": "&lt;p&gt;&amp;#39;&lt;/p&gt;" }] })
		);
	}

	#[test]
	fn error_statuses() {
		assert_eq!(error_status("Reddit error 404 \"\": \"Not Found\" | /r/x.json"), 404);
		assert_eq!(error_status("private"), 403);
		assert_eq!(error_status("banned"), 404);
		assert_eq!(error_status("Reddit rate limit exceeded"), 429);
		assert_eq!(error_status("Too many requests."), 429);
		assert_eq!(error_status("Reddit comments request returned 429 Too Many Requests"), 429);
		assert_eq!(error_status("Post not found"), 404);
		assert_eq!(error_status("OAuth token has expired. Please refresh the page!"), 503);
		assert_eq!(error_status("Couldn't send request to Reddit: boom | /x"), 502);
		assert_eq!(error_status(crate::client::OAUTH_NOT_READY), 503);
		assert_eq!(error_status("something new"), 502);
	}

	#[test]
	fn retry_after_comes_from_reddits_reset() {
		use crate::utils::retry_after;
		assert_eq!(retry_after("Reddit rate limit exceeded. Try refreshing in a few seconds.Rate limit will reset in: 233.4", 429), Some(234));
		assert_eq!(retry_after("Reddit rate limit exceeded", 429), Some(30));
		assert_eq!(retry_after("OAuth token has expired. Please refresh the page!", 503), Some(30));
		assert_eq!(retry_after("Couldn't send request to Reddit", 502), None);
		assert_eq!(crate::utils::reddit_error_status("Nothing here"), None, "web pages keep their 404");
	}
}
