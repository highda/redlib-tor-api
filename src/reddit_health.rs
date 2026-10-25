//! Tracks whether Reddit answers, from the last requests made to it.

use log::info;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const WINDOW: usize = 20;
const SUMMARY_EVERY: Duration = Duration::from_secs(300);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome {
	/// Reddit answered with JSON.
	Ok,
	/// Reddit refused the request (403 block page, rejected token, HTML instead of JSON).
	Blocked,
	/// Reddit's rate limit.
	RateLimited,
	/// No usable answer: Tor, timeouts, Reddit outages.
	Network,
}

static RECENT: LazyLock<Mutex<VecDeque<(Instant, Outcome)>>> = LazyLock::new(Default::default);

/// Counts since the last summary line, per outcome.
static SINCE_SUMMARY: [AtomicU32; 4] = [AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0)];

pub fn record(outcome: Outcome) {
	let mut recent = RECENT.lock().unwrap_or_else(|e| e.into_inner());
	if recent.len() == WINDOW {
		recent.pop_front();
	}
	recent.push_back((Instant::now(), outcome));
	SINCE_SUMMARY[outcome as usize].fetch_add(1, Ordering::Relaxed);
}

/// Records the outcome of a request to Reddit from its result. Answers about
/// the content (not found, private, banned...) say nothing about blocking.
pub fn record_result<T>(result: &Result<T, String>) {
	if let Some(outcome) = outcome_of(result.as_ref().err().map(String::as_str)) {
		record(outcome);
	}
}

fn outcome_of(error: Option<&str>) -> Option<Outcome> {
	let Some(error) = error else { return Some(Outcome::Ok) };
	let lower = error.to_ascii_lowercase();
	Some(if lower.contains("rate limit") || lower.contains("too many requests") {
		Outcome::RateLimited
	} else if ["Reddit blocked this request", "Failed to parse page JSON data", "OAuth token has expired", "Reddit returned an invalid comments response"]
		.iter()
		.any(|p| error.starts_with(p))
	{
		Outcome::Blocked
	} else if [
		"Couldn't send request to Reddit",
		"Failed receiving body from Reddit",
		"Reddit is having issues",
		"Too many redirects from Reddit",
		"Reddit comments request",
		"Reddit comments API error",
	]
	.iter()
	.any(|p| error.starts_with(p))
	{
		Outcome::Network
	} else {
		return None;
	})
}

/// Whether most recent requests got an answer from Reddit, and a one-line summary.
pub fn status() -> (bool, String) {
	summarize(&RECENT.lock().unwrap_or_else(|e| e.into_inner()))
}

fn summarize(recent: &VecDeque<(Instant, Outcome)>) -> (bool, String) {
	let Some((newest, _)) = recent.back() else {
		return (true, "ok: no Reddit requests yet\n".to_string());
	};
	let count = |o: Outcome| recent.iter().filter(|(_, x)| *x == o).count();
	let (ok, blocked, limited, network) = (count(Outcome::Ok), count(Outcome::Blocked), count(Outcome::RateLimited), count(Outcome::Network));
	let healthy = ok * 2 >= recent.len();
	let summary = format!(
		"{}: last {} Reddit requests: {ok} ok, {blocked} blocked, {limited} rate-limited, {network} network; newest {}s ago\n",
		if healthy { "ok" } else { "failing" },
		recent.len(),
		newest.elapsed().as_secs()
	);
	(healthy, summary)
}

/// Logs the counts per outcome every 5 minutes when there were requests;
/// nothing about what was requested.
pub fn start_summary_log() {
	tokio::spawn(async {
		loop {
			tokio::time::sleep(SUMMARY_EVERY).await;
			let counts = SINCE_SUMMARY.each_ref().map(|c| c.swap(0, Ordering::Relaxed));
			if counts.iter().any(|&c| c > 0) {
				let [ok, blocked, limited, network] = counts;
				info!("Reddit requests in the last 5 min: {ok} ok, {blocked} blocked, {limited} rate-limited, {network} network");
			}
		}
	});
}

#[cfg(test)]
mod tests {
	use super::*;

	fn of(outcomes: &[Outcome]) -> VecDeque<(Instant, Outcome)> {
		outcomes.iter().map(|o| (Instant::now(), *o)).collect()
	}

	#[test]
	fn healthy_until_most_requests_fail() {
		use Outcome::*;
		assert!(summarize(&of(&[])).0);
		assert!(summarize(&of(&[Ok, Blocked])).0);
		assert!(!summarize(&of(&[Ok, RateLimited, Blocked])).0);
		let (healthy, text) = summarize(&of(&[Blocked, Network, Ok, Ok]));
		assert!(healthy);
		assert!(text.starts_with("ok: last 4 Reddit requests: 2 ok, 1 blocked, 0 rate-limited, 1 network;"), "{text}");
	}

	#[test]
	fn keeps_only_the_window() {
		for _ in 0..WINDOW + 5 {
			record(Outcome::Blocked);
		}
		assert_eq!(RECENT.lock().unwrap().len(), WINDOW);
	}

	#[test]
	fn classifies_errors() {
		assert_eq!(outcome_of(None), Some(Outcome::Ok));
		assert_eq!(outcome_of(Some("Reddit blocked this request (403 Forbidden) | /r/x")), Some(Outcome::Blocked));
		assert_eq!(outcome_of(Some("Reddit rate limit exceeded")), Some(Outcome::RateLimited));
		assert_eq!(outcome_of(Some("Couldn't send request to Reddit: timeout | /r/x")), Some(Outcome::Network));
		assert_eq!(outcome_of(Some("Reddit comments request returned 502 Bad Gateway")), Some(Outcome::Network));
		assert_eq!(outcome_of(Some("Reddit error 404 \"\": \"Not Found\" | /r/x")), None);
		assert_eq!(outcome_of(Some("private")), None);
		assert_eq!(outcome_of(Some(crate::client::OAUTH_NOT_READY)), None);
	}

	#[test]
	fn outcomes_index_the_counters() {
		const OUTCOMES: [Outcome; 4] = [Outcome::Ok, Outcome::Blocked, Outcome::RateLimited, Outcome::Network];
		assert!(OUTCOMES.iter().enumerate().all(|(i, o)| *o as usize == i));
	}
}
