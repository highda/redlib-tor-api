use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use cookie::Cookie;
use hmac::{Hmac, Mac};
use hyper::{body, header::HeaderValue, Body, HeaderMap, Request, Response};
use log::{debug, warn};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
	collections::HashSet,
	sync::{LazyLock, RwLock},
};
use time::{Duration, OffsetDateTime};

use crate::{client::CLIENT, config, server::RequestExt};

type HmacSha256 = Hmac<Sha256>;

const VALIDATION_COOKIE: &str = "yay";
const GATE_COOKIE: &str = "eris";
const SCRIPT_PATH: &str = "/__aqua/yurification.js";
const VERIFY_PATH: &str = "/__aqua/axis_order";
const FINGERPRINT_VERSION: u8 = 1;
const TOKEN_DATA_LEN: usize = 1 + 8 + 16 + 8;
const TOKEN_LEN: usize = TOKEN_DATA_LEN + 32;

const CHROME_ALLOWED_LAG_MAJORS: u32 = 11;
const FIREFOX_ALLOWED_LAG_MAJORS: u32 = 11;
const VERSION_REFRESH_SECONDS: i64 = 6 * 60 * 60;

const GATE_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="robots" content="noindex,nofollow,noarchive,nosnippet">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title></title>
	<style>html,body{margin:0;padding:0;background:#fff}</style>
	<script src="/__aqua/yurification.js" defer></script>
</head>
<body></body>
</html>
"#;

#[derive(Debug, Deserialize)]
struct FingerprintReport {
	#[serde(default)]
	v: u8,
	#[serde(default)]
	webdriver: Option<bool>,
	#[serde(default)]
	max_touch_points: Option<u16>,
	#[serde(default)]
	touch_event: Option<bool>,
	#[serde(default)]
	platform: Option<String>,
	#[serde(default)]
	tz: Option<String>,
	#[serde(default)]
	langs: Option<Vec<String>>,
	#[serde(default)]
	canvas: Option<String>,
	#[serde(default)]
	audio: Option<String>,
	#[serde(default)]
	audio_supported: Option<bool>,
	#[serde(default)]
	webgl_vendor: Option<String>,
	#[serde(default)]
	webgl_renderer: Option<String>,
	#[serde(default)]
	hardware_concurrency: Option<u16>,
	#[serde(default)]
	device_memory: Option<f32>,
	#[serde(default)]
	screen_w: Option<u32>,
	#[serde(default)]
	screen_h: Option<u32>,
	#[serde(default)]
	dpr: Option<f32>,
	#[serde(default)]
	plugins: Option<u16>,
}

struct Settings {
	enabled: bool,
	secret: Vec<u8>,
	max_age_seconds: i64,
	score_threshold: u32,
	blocklist: HashSet<[u8; 16]>,
}

#[derive(Clone, Copy, Debug, Default)]
struct BrowserVersions {
	last_refresh_unix: i64,
	chrome_stable_major: Option<u32>,
	firefox_stable_major: Option<u32>,
}

static SETTINGS: LazyLock<Settings> = LazyLock::new(load_settings);
static BROWSER_VERSIONS: LazyLock<RwLock<BrowserVersions>> = LazyLock::new(|| RwLock::new(BrowserVersions::default()));

pub fn enabled() -> bool {
	SETTINGS.enabled
}

pub fn is_exempt_path(path: &str) -> bool {
	matches!(
		path,
		SCRIPT_PATH | VERIFY_PATH | "/favicon.ico" | "/robots.txt" | "/logo.png" | "/touch-icon-iphone.png" | "/apple-touch-icon.png" | "/healthz/reddit"
	) || path.starts_with("/raw/")
}

pub fn start_ua_version_refresh() {
	if !enabled() {
		return;
	}

	tokio::spawn(async {
		loop {
			if let Err(err) = refresh_browser_versions().await {
				debug!("fingerprint browser-version refresh failed: {err}");
			}
			tokio::time::sleep(std::time::Duration::from_secs(VERSION_REFRESH_SECONDS as u64)).await;
		}
	});
}

pub fn is_suspicious_headers(headers: &HeaderMap<HeaderValue>) -> bool {
	let Some(ua) = header_str(headers, "user-agent") else {
		return true;
	};
	let ua_lc = ua.to_ascii_lowercase();

	if ua_lc.contains("msie") || ua_lc.contains("trident/") || ua_lc.contains("iemobile") {
		return true;
	}

	let non_browser_markers = [
		"curl/",
		"wget/",
		"python-requests",
		"go-http-client",
		"httpie/",
		"postmanruntime/",
		"libwww-perl",
		"java/",
		"okhttp",
		"scrapy",
	];
	if non_browser_markers.iter().any(|marker| ua_lc.contains(marker)) {
		return true;
	}

	if headers.get("accept").is_none() && headers.get("accept-language").is_none() {
		return true;
	}

	ua_is_too_old(&ua_lc)
}

pub fn verify_cookie(req: &Request<Body>) -> bool {
	let token = match req.cookie(VALIDATION_COOKIE) {
		Some(cookie) => cookie.value().to_owned(),
		None => return false,
	};

	let decoded = match URL_SAFE_NO_PAD.decode(token.as_bytes()) {
		Ok(decoded) => decoded,
		Err(_) => return false,
	};
	if decoded.len() != TOKEN_LEN || decoded[0] != FINGERPRINT_VERSION {
		return false;
	}

	let issued_at = u64::from_be_bytes(decoded[1..9].try_into().unwrap_or_default()) as i64;
	let now = OffsetDateTime::now_utc().unix_timestamp();
	if issued_at <= 0 || now.saturating_sub(issued_at) > SETTINGS.max_age_seconds {
		return false;
	}

	let fp_id: [u8; 16] = decoded[9..25].try_into().unwrap_or_default();
	if SETTINGS.blocklist.contains(&fp_id) {
		return false;
	}

	let ua = header_str(req.headers(), "user-agent").unwrap_or_default();
	let token_ua_hash: [u8; 8] = decoded[25..33].try_into().unwrap_or_default();
	if token_ua_hash != hash_ua(&ua) {
		return false;
	}

	let mut mac = match HmacSha256::new_from_slice(&SETTINGS.secret) {
		Ok(mac) => mac,
		Err(_) => return false,
	};
	mac.update(&decoded[..TOKEN_DATA_LEN]);
	mac.verify_slice(&decoded[TOKEN_DATA_LEN..]).is_ok()
}

pub fn gate_cookie_present(req: &Request<Body>) -> bool {
	req.cookie(GATE_COOKIE).is_some()
}

pub fn blank_response() -> Response<Body> {
	Response::builder().status(200).header("cache-control", "no-store").body(Body::empty()).unwrap()
}

pub fn gate_page_response(headers: &HeaderMap<HeaderValue>) -> Response<Body> {
	let mut response = Response::builder()
		.status(200)
		.header("content-type", "text/html; charset=utf-8")
		.header("cache-control", "no-store")
		.header("pragma", "no-cache")
		.body(Body::from(GATE_HTML))
		.unwrap();

	let expires = OffsetDateTime::now_utc() + Duration::minutes(10);
	let mut cookie = Cookie::build((GATE_COOKIE, "pads_her_chest")).path("/").http_only(true).expires(expires);
	if is_https(headers) {
		cookie = cookie.secure(true);
	}
	if let Ok(value) = HeaderValue::from_str(&cookie.to_string()) {
		response.headers_mut().append("set-cookie", value);
	}

	response
}

pub async fn script(req: Request<Body>) -> Result<Response<Body>, String> {
	if is_suspicious_headers(req.headers()) {
		return Ok(blank_response());
	}

	Ok(
		Response::builder()
			.status(200)
			.header("content-type", "text/javascript; charset=utf-8")
			.header("cache-control", "no-store")
			.body(Body::from(include_str!("../static/fingerprint.js")))
			.unwrap(),
	)
}

pub async fn verify(req: Request<Body>) -> Result<Response<Body>, String> {
	if !enabled() {
		return Ok(json_response(true, None));
	}

	let headers = req.headers().clone();
	let ua = header_str(&headers, "user-agent").unwrap_or_default();
	let bytes = body::to_bytes(req.into_body()).await.map_err(|e| format!("failed to read fingerprint report: {e}"))?;
	if bytes.len() > 16 * 1024 {
		return Ok(json_response(false, None));
	}

	let report = match serde_json::from_slice::<FingerprintReport>(&bytes) {
		Ok(report) if report.v == FINGERPRINT_VERSION => report,
		_ => return Ok(json_response(false, None)),
	};

	let (accepted, fp_id) = evaluate(&report, &headers, &ua);
	if !accepted {
		return Ok(json_response(false, Some(fp_id)));
	}

	let now = OffsetDateTime::now_utc();
	let token = issue_token(now.unix_timestamp(), fp_id, hash_ua(&ua));
	let mut cookie = Cookie::build((VALIDATION_COOKIE, token))
		.path("/")
		.http_only(true)
		.expires(now + Duration::seconds(SETTINGS.max_age_seconds));
	if is_https(&headers) {
		cookie = cookie.secure(true);
	}

	let mut response = json_response(true, Some(fp_id));
	if let Ok(value) = HeaderValue::from_str(&cookie.to_string()) {
		response.headers_mut().append("set-cookie", value);
	}
	Ok(response)
}

fn load_settings() -> Settings {
	let enabled = matches!(config::get_setting("REDLIB_FINGERPRINTING").as_deref(), Some("on"));
	let max_age_seconds = config::get_setting("REDLIB_FINGERPRINT_MAX_AGE_SECONDS")
		.and_then(|value| value.parse::<i64>().ok())
		.filter(|value| *value > 0 && *value <= 60 * 60 * 24 * 30)
		.unwrap_or(60 * 60 * 24);
	let score_threshold = config::get_setting("REDLIB_FINGERPRINT_SCORE_THRESHOLD")
		.and_then(|value| value.parse::<u32>().ok())
		.filter(|value| (1..=10_000).contains(value))
		.unwrap_or(50);
	let secret = config::get_setting("REDLIB_FINGERPRINT_SECRET")
		.filter(|value| !value.is_empty())
		.map(String::into_bytes)
		.unwrap_or_else(|| {
			if enabled {
				warn!("REDLIB_FINGERPRINTING is on but REDLIB_FINGERPRINT_SECRET is unset; validation cookies will reset on restart.");
			}
			let mut bytes = [0_u8; 32];
			fastrand::fill(&mut bytes);
			bytes.to_vec()
		});
	let blocklist = config::get_setting("REDLIB_FINGERPRINT_BLOCKLIST")
		.unwrap_or_default()
		.split(',')
		.filter_map(parse_fp_id_hex)
		.collect();

	Settings {
		enabled,
		secret,
		max_age_seconds,
		score_threshold,
		blocklist,
	}
}

async fn refresh_browser_versions() -> Result<(), String> {
	let now = OffsetDateTime::now_utc().unix_timestamp();
	{
		let state = BROWSER_VERSIONS.read().map_err(|_| "browser version cache is poisoned".to_string())?;
		if state.last_refresh_unix > 0 && now.saturating_sub(state.last_refresh_unix) < VERSION_REFRESH_SECONDS {
			return Ok(());
		}
	}

	let (chrome, firefox) = tokio::join!(fetch_chrome_major(), fetch_firefox_major());
	let mut state = BROWSER_VERSIONS.write().map_err(|_| "browser version cache is poisoned".to_string())?;
	state.last_refresh_unix = now;
	if let Ok(version) = chrome {
		state.chrome_stable_major = Some(version);
	}
	if let Ok(version) = firefox {
		state.firefox_stable_major = Some(version);
	}
	Ok(())
}

async fn fetch_chrome_major() -> Result<u32, String> {
	let json: serde_json::Value = CLIENT
		.get("https://versionhistory.googleapis.com/v1/chrome/platforms/linux/channels/stable/versions?pageSize=1")
		.send()
		.await
		.map_err(|e| format!("chrome version request failed: {e}"))?
		.json()
		.await
		.map_err(|e| format!("chrome version json failed: {e}"))?;

	let version = json["versions"][0]["version"].as_str().ok_or_else(|| "chrome version missing".to_string())?;
	parse_major(version).ok_or_else(|| "chrome version malformed".to_string())
}

async fn fetch_firefox_major() -> Result<u32, String> {
	let json: serde_json::Value = CLIENT
		.get("https://product-details.mozilla.org/1.0/firefox_versions.json")
		.send()
		.await
		.map_err(|e| format!("firefox version request failed: {e}"))?
		.json()
		.await
		.map_err(|e| format!("firefox version json failed: {e}"))?;

	let version = json["LATEST_FIREFOX_VERSION"].as_str().ok_or_else(|| "firefox version missing".to_string())?;
	parse_major(version).ok_or_else(|| "firefox version malformed".to_string())
}

fn evaluate(report: &FingerprintReport, headers: &HeaderMap<HeaderValue>, ua: &str) -> (bool, [u8; 16]) {
	let fp_id = fingerprint_id(report);
	if SETTINGS.blocklist.contains(&fp_id) {
		return (false, fp_id);
	}

	let ua_lc = ua.to_ascii_lowercase();
	let mut score = 0_u32;

	if report.webdriver == Some(true) || ua_lc.contains("headlesschrome") || ua_lc.contains("phantomjs") || ua_lc.contains("selenium") {
		score += 10_000;
	}
	if is_suspicious_headers(headers) {
		score += 1_000;
	}
	score += platform_consistency_score(
		&ua_lc,
		report.platform.as_deref(),
		report.max_touch_points.unwrap_or(0),
		report.touch_event.unwrap_or(false),
	);

	let is_mobile_ua = ua_lc.contains("iphone") || ua_lc.contains("ipad") || ua_lc.contains("android");
	let has_touch = report.max_touch_points.unwrap_or(0) > 0 || report.touch_event.unwrap_or(false);
	if is_mobile_ua && !has_touch {
		score += 250;
	}
	if report.canvas.as_deref().unwrap_or_default().is_empty() {
		score += 50;
	}
	if report.audio_supported != Some(true) || report.audio.as_deref().unwrap_or_default().is_empty() {
		score += 35;
	}
	if report.webgl_renderer.as_deref().unwrap_or_default().is_empty() {
		score += 25;
	}
	if report.tz.as_deref().unwrap_or_default().is_empty() {
		score += 10;
	}
	if report.langs.as_ref().map(Vec::is_empty).unwrap_or(true) {
		score += 10;
	}
	if report.plugins == Some(0) {
		score += 25;
	}
	if report.screen_w.unwrap_or(0) == 0 || report.screen_h.unwrap_or(0) == 0 || report.dpr.unwrap_or(0.0) <= 0.0 {
		score += 25;
	}

	(score < SETTINGS.score_threshold, fp_id)
}

fn ua_is_too_old(ua_lc: &str) -> bool {
	if let Some(major) = chrome_family_major(ua_lc) {
		let current = BROWSER_VERSIONS.read().ok().and_then(|state| state.chrome_stable_major);
		return current.is_some_and(|current| major < current.saturating_sub(CHROME_ALLOWED_LAG_MAJORS));
	}

	if let Some(major) = firefox_family_major(ua_lc) {
		let current = BROWSER_VERSIONS.read().ok().and_then(|state| state.firefox_stable_major);
		return current.is_some_and(|current| major < current.saturating_sub(FIREFOX_ALLOWED_LAG_MAJORS));
	}

	false
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
enum BrowserOs {
	Windows,
	Mac,
	Linux,
	Android,
	Ios,
	Unknown,
}

fn platform_consistency_score(ua_lc: &str, platform: Option<&str>, max_touch_points: u16, touch_event: bool) -> u32 {
	let ua_os = classify_ua_os(ua_lc);
	let platform_lc = platform.unwrap_or_default().to_ascii_lowercase();
	let platform_os = classify_platform_os(&platform_lc);

	if ua_lc.contains("ipad") && platform_lc.contains("mac") && (max_touch_points > 1 || touch_event) {
		return 0;
	}
	if ua_os == BrowserOs::Android && platform_os == BrowserOs::Linux {
		return 0;
	}

	match (ua_os, platform_os) {
		(BrowserOs::Windows, BrowserOs::Mac | BrowserOs::Linux | BrowserOs::Ios) => 1_000,
		(BrowserOs::Mac, BrowserOs::Windows | BrowserOs::Linux) => 1_000,
		(BrowserOs::Linux, BrowserOs::Windows | BrowserOs::Mac | BrowserOs::Ios) => 1_000,
		(BrowserOs::Android, BrowserOs::Windows | BrowserOs::Mac | BrowserOs::Ios) => 1_000,
		(BrowserOs::Ios, BrowserOs::Windows | BrowserOs::Linux) => 1_000,
		_ => 0,
	}
}

fn classify_ua_os(ua_lc: &str) -> BrowserOs {
	if ua_lc.contains("android") {
		BrowserOs::Android
	} else if ua_lc.contains("iphone") || ua_lc.contains("ipad") || ua_lc.contains("ipod") {
		BrowserOs::Ios
	} else if ua_lc.contains("windows") || ua_lc.contains("win64") || ua_lc.contains("win32") {
		BrowserOs::Windows
	} else if ua_lc.contains("macintosh") || ua_lc.contains("mac os x") {
		BrowserOs::Mac
	} else if ua_lc.contains("x11") || ua_lc.contains("linux") {
		BrowserOs::Linux
	} else {
		BrowserOs::Unknown
	}
}

fn classify_platform_os(platform_lc: &str) -> BrowserOs {
	if platform_lc.contains("win") {
		BrowserOs::Windows
	} else if platform_lc.contains("iphone") || platform_lc.contains("ipad") || platform_lc.contains("ipod") {
		BrowserOs::Ios
	} else if platform_lc.contains("mac") {
		BrowserOs::Mac
	} else if platform_lc.contains("linux") {
		BrowserOs::Linux
	} else {
		BrowserOs::Unknown
	}
}

fn fingerprint_id(report: &FingerprintReport) -> [u8; 16] {
	let mut input = Vec::with_capacity(512);
	input.extend_from_slice(b"v1\0");
	push_opt(&mut input, report.canvas.as_deref());
	push_opt(&mut input, report.audio.as_deref());
	push_opt(&mut input, report.webgl_vendor.as_deref());
	push_opt(&mut input, report.webgl_renderer.as_deref());
	push_opt(&mut input, report.platform.as_deref());
	push_opt(&mut input, report.tz.as_deref());
	if let Some(langs) = &report.langs {
		for lang in langs {
			push_opt(&mut input, Some(lang.as_str()));
		}
	} else {
		input.push(0);
	}
	push_opt(&mut input, report.hardware_concurrency.map(|value| value.to_string()).as_deref());
	push_opt(&mut input, report.device_memory.map(|value| value.to_string()).as_deref());
	push_opt(&mut input, report.screen_w.map(|value| value.to_string()).as_deref());
	push_opt(&mut input, report.screen_h.map(|value| value.to_string()).as_deref());
	push_opt(&mut input, report.dpr.map(|value| value.to_string()).as_deref());
	push_opt(&mut input, report.plugins.map(|value| value.to_string()).as_deref());

	let digest = Sha256::digest(input);
	let mut out = [0_u8; 16];
	out.copy_from_slice(&digest[..16]);
	out
}

fn issue_token(ts: i64, fp_id: [u8; 16], ua_hash: [u8; 8]) -> String {
	let mut data = [0_u8; TOKEN_DATA_LEN];
	data[0] = FINGERPRINT_VERSION;
	data[1..9].copy_from_slice(&(ts.max(0) as u64).to_be_bytes());
	data[9..25].copy_from_slice(&fp_id);
	data[25..33].copy_from_slice(&ua_hash);

	let mut mac = HmacSha256::new_from_slice(&SETTINGS.secret).expect("HMAC accepts arbitrary key lengths");
	mac.update(&data);

	let mut token = Vec::with_capacity(TOKEN_LEN);
	token.extend_from_slice(&data);
	token.extend_from_slice(&mac.finalize().into_bytes());
	URL_SAFE_NO_PAD.encode(token)
}

fn json_response(ok: bool, fp_id: Option<[u8; 16]>) -> Response<Body> {
	let body = match fp_id {
		Some(fp_id) => format!(r#"{{"ok":{},"fp":"{}"}}"#, ok, hex_lower(&fp_id)),
		None => format!(r#"{{"ok":{}}}"#, ok),
	};
	Response::builder()
		.status(200)
		.header("content-type", "application/json; charset=utf-8")
		.header("cache-control", "no-store")
		.body(Body::from(body))
		.unwrap()
}

fn push_opt(buf: &mut Vec<u8>, value: Option<&str>) {
	if let Some(value) = value {
		buf.extend_from_slice(value.as_bytes());
	}
	buf.push(0);
}

fn hash_ua(ua: &str) -> [u8; 8] {
	let digest = Sha256::digest(ua.as_bytes());
	let mut out = [0_u8; 8];
	out.copy_from_slice(&digest[..8]);
	out
}

fn chrome_family_major(ua_lc: &str) -> Option<u32> {
	["edg/", "edgios/", "crios/", "opr/", "chrome/"].iter().find_map(|token| major_after(ua_lc, token))
}

fn firefox_family_major(ua_lc: &str) -> Option<u32> {
	["firefox/", "fxios/"].iter().find_map(|token| major_after(ua_lc, token))
}

fn major_after(input: &str, token: &str) -> Option<u32> {
	let tail = input.get(input.find(token)? + token.len()..)?;
	let digits: String = tail.chars().take_while(|ch| ch.is_ascii_digit()).collect();
	digits.parse().ok()
}

fn parse_major(version: &str) -> Option<u32> {
	version.split('.').next()?.parse().ok()
}

fn parse_fp_id_hex(value: &str) -> Option<[u8; 16]> {
	let value = value.trim();
	if value.len() != 32 {
		return None;
	}

	let mut out = [0_u8; 16];
	for (i, slot) in out.iter_mut().enumerate() {
		let hi = hex_val(value.as_bytes()[i * 2])?;
		let lo = hex_val(value.as_bytes()[i * 2 + 1])?;
		*slot = (hi << 4) | lo;
	}
	Some(out)
}

fn hex_val(byte: u8) -> Option<u8> {
	match byte {
		b'0'..=b'9' => Some(byte - b'0'),
		b'a'..=b'f' => Some(byte - b'a' + 10),
		b'A'..=b'F' => Some(byte - b'A' + 10),
		_ => None,
	}
}

fn hex_lower(bytes: &[u8]) -> String {
	const LUT: &[u8; 16] = b"0123456789abcdef";
	let mut out = Vec::with_capacity(bytes.len() * 2);
	for byte in bytes {
		out.push(LUT[(byte >> 4) as usize]);
		out.push(LUT[(byte & 0x0f) as usize]);
	}
	String::from_utf8(out).unwrap_or_default()
}

fn header_str(headers: &HeaderMap<HeaderValue>, name: &str) -> Option<String> {
	headers.get(name).and_then(|header| header.to_str().ok()).map(ToOwned::to_owned)
}

fn is_https(headers: &HeaderMap<HeaderValue>) -> bool {
	headers
		.get("x-forwarded-proto")
		.and_then(|header| header.to_str().ok())
		.is_some_and(|proto| proto.eq_ignore_ascii_case("https"))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn hex_id_round_trips() {
		let id = [0xabu8; 16];
		assert_eq!(parse_fp_id_hex(&hex_lower(&id)), Some(id));
	}

	#[test]
	fn public_gate_contract_matches_previous_impl() {
		assert_eq!(VALIDATION_COOKIE, "yay");
		assert_eq!(GATE_COOKIE, "eris");
		assert!(is_exempt_path("/__aqua/yurification.js"));
		assert!(is_exempt_path("/__aqua/axis_order"));
		assert!(GATE_HTML.contains("/__aqua/yurification.js"));
		assert!(!GATE_HTML.contains("__redlib"));
	}

	#[test]
	fn parses_browser_majors() {
		assert_eq!(chrome_family_major("mozilla/5.0 chrome/131.0.0.0 safari/537.36"), Some(131));
		assert_eq!(chrome_family_major("mozilla/5.0 edg/132.0.0.0 chrome/132.0.0.0"), Some(132));
		assert_eq!(firefox_family_major("mozilla/5.0 firefox/133.0"), Some(133));
	}

	#[test]
	fn detects_platform_mismatch() {
		let ua = "mozilla/5.0 (windows nt 10.0; win64; x64) applewebkit/537.36 chrome/131.0.0.0 safari/537.36";
		assert!(platform_consistency_score(ua, Some("Linux x86_64"), 0, false) >= 1_000);
	}
}
