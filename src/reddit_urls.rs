use crate::config;

pub(crate) const REDDIT_ONION: &str = "reddittorjg6rue252oqsxryoxengawnmo46qy4kyii5wtqnwfj4ooad.onion";
pub(crate) const REDDIT_DOT_ONION: &str = "redditdotzhmh3mao6r5i2j7speppwqkizwo7vksy3mbz5iz7rlhocyd.onion";
pub(crate) const REDDIT_MEDIA_ONION: &str = "reddit4hkhcpcf2mkmuotdlk3gknuzcatsw4f7dx7twdkwmtrt6ax4qd.onion";
pub(crate) const REDDIT_STATIC_ONION: &str = "reddittic34i5gtjcnm2fb7fv2eyop4vbxquuc36prnbs7d2kp3saoqd.onion";

pub(crate) const OAUTH_REDDIT_BASE: &str = "https://oauth.reddit.com";
pub(crate) const OAUTH_REDDIT_HOST: &str = "oauth.reddit.com";
pub(crate) const OAUTH_REDDIT_ONION_BASE: &str = "https://oauth.reddittorjg6rue252oqsxryoxengawnmo46qy4kyii5wtqnwfj4ooad.onion";
pub(crate) const OAUTH_REDDIT_ONION_HOST: &str = "oauth.reddittorjg6rue252oqsxryoxengawnmo46qy4kyii5wtqnwfj4ooad.onion";

pub(crate) const WWW_REDDIT_BASE: &str = "https://www.reddit.com";
pub(crate) const WWW_REDDIT_HOST: &str = "www.reddit.com";
pub(crate) const WWW_REDDIT_ONION_BASE: &str = "https://www.reddittorjg6rue252oqsxryoxengawnmo46qy4kyii5wtqnwfj4ooad.onion";
pub(crate) const WWW_REDDIT_ONION_HOST: &str = "www.reddittorjg6rue252oqsxryoxengawnmo46qy4kyii5wtqnwfj4ooad.onion";

pub(crate) const SHORT_REDDIT_BASE: &str = "https://redd.it";
pub(crate) const SHORT_REDDIT_HOST: &str = "redd.it";
pub(crate) const SHORT_REDDIT_ONION_BASE: &str = "https://redditdotzhmh3mao6r5i2j7speppwqkizwo7vksy3mbz5iz7rlhocyd.onion";
pub(crate) const SHORT_REDDIT_ONION_HOST: &str = "redditdotzhmh3mao6r5i2j7speppwqkizwo7vksy3mbz5iz7rlhocyd.onion";

pub(crate) const GQL_REDDIT_URL: &str = "https://gql-fed.reddit.com/";
pub(crate) const GQL_REDDIT_ONION_URL: &str = "https://gql-fed.reddittorjg6rue252oqsxryoxengawnmo46qy4kyii5wtqnwfj4ooad.onion/";

pub(crate) fn use_reddit_onion() -> bool {
	matches!(config::get_setting("REDLIB_USE_REDDIT_ONION").as_deref(), Some("on" | "true" | "1" | "yes"))
}

pub(crate) fn oauth_base() -> (&'static str, &'static str) {
	if use_reddit_onion() {
		(OAUTH_REDDIT_ONION_BASE, OAUTH_REDDIT_ONION_HOST)
	} else {
		(OAUTH_REDDIT_BASE, OAUTH_REDDIT_HOST)
	}
}

pub(crate) fn gql_url() -> &'static str {
	if use_reddit_onion() {
		GQL_REDDIT_ONION_URL
	} else {
		GQL_REDDIT_URL
	}
}

pub(crate) fn www_base() -> (&'static str, &'static str) {
	if use_reddit_onion() {
		(WWW_REDDIT_ONION_BASE, WWW_REDDIT_ONION_HOST)
	} else {
		(WWW_REDDIT_BASE, WWW_REDDIT_HOST)
	}
}

pub(crate) fn short_base() -> (&'static str, &'static str) {
	if use_reddit_onion() {
		(SHORT_REDDIT_ONION_BASE, SHORT_REDDIT_ONION_HOST)
	} else {
		(SHORT_REDDIT_BASE, SHORT_REDDIT_HOST)
	}
}

pub(crate) fn canonical_head_bases() -> [(&'static str, &'static str); 2] {
	[www_base(), short_base()]
}

pub(crate) fn to_onion_url(url: &str) -> String {
	to_onion_url_for(url, use_reddit_onion())
}

pub(crate) fn to_onion_url_for(url: &str, enabled: bool) -> String {
	if !enabled {
		return url.to_string();
	}

	url
		.replace(
			"https://external-preview.redd.it",
			"https://external-preview.redditdotzhmh3mao6r5i2j7speppwqkizwo7vksy3mbz5iz7rlhocyd.onion",
		)
		.replace("https://preview.redd.it", "https://preview.redditdotzhmh3mao6r5i2j7speppwqkizwo7vksy3mbz5iz7rlhocyd.onion")
		.replace("https://www.reddit.com", "https://www.reddittorjg6rue252oqsxryoxengawnmo46qy4kyii5wtqnwfj4ooad.onion")
		.replace("https://old.reddit.com", "https://old.reddittorjg6rue252oqsxryoxengawnmo46qy4kyii5wtqnwfj4ooad.onion")
		.replace("https://np.reddit.com", "https://np.reddittorjg6rue252oqsxryoxengawnmo46qy4kyii5wtqnwfj4ooad.onion")
		.replace("https://oauth.reddit.com", "https://oauth.reddittorjg6rue252oqsxryoxengawnmo46qy4kyii5wtqnwfj4ooad.onion")
		.replace("https://reddit.com", "https://reddittorjg6rue252oqsxryoxengawnmo46qy4kyii5wtqnwfj4ooad.onion")
		.replace("https://v.redd.it", "https://v.redditdotzhmh3mao6r5i2j7speppwqkizwo7vksy3mbz5iz7rlhocyd.onion")
		.replace("https://i.redd.it", "https://i.redditdotzhmh3mao6r5i2j7speppwqkizwo7vksy3mbz5iz7rlhocyd.onion")
		.replace("https://redd.it", "https://redditdotzhmh3mao6r5i2j7speppwqkizwo7vksy3mbz5iz7rlhocyd.onion")
		.replace("https://www.redditstatic.com", "https://www.reddittic34i5gtjcnm2fb7fv2eyop4vbxquuc36prnbs7d2kp3saoqd.onion")
		.replace("https://redditstatic.com", "https://reddittic34i5gtjcnm2fb7fv2eyop4vbxquuc36prnbs7d2kp3saoqd.onion")
		.replace(
			"https://a.thumbs.redditmedia.com",
			"https://a.thumbs.reddit4hkhcpcf2mkmuotdlk3gknuzcatsw4f7dx7twdkwmtrt6ax4qd.onion",
		)
		.replace(
			"https://b.thumbs.redditmedia.com",
			"https://b.thumbs.reddit4hkhcpcf2mkmuotdlk3gknuzcatsw4f7dx7twdkwmtrt6ax4qd.onion",
		)
		.replace(
			"https://styles.redditmedia.com",
			"https://styles.reddit4hkhcpcf2mkmuotdlk3gknuzcatsw4f7dx7twdkwmtrt6ax4qd.onion",
		)
		.replace(
			"https://emoji.redditmedia.com",
			"https://emoji.reddit4hkhcpcf2mkmuotdlk3gknuzcatsw4f7dx7twdkwmtrt6ax4qd.onion",
		)
}

pub(crate) fn to_clearnet_url(url: &str) -> String {
	url
		.replace("https://www.reddittorjg6rue252oqsxryoxengawnmo46qy4kyii5wtqnwfj4ooad.onion", "https://www.reddit.com")
		.replace("https://old.reddittorjg6rue252oqsxryoxengawnmo46qy4kyii5wtqnwfj4ooad.onion", "https://old.reddit.com")
		.replace("https://np.reddittorjg6rue252oqsxryoxengawnmo46qy4kyii5wtqnwfj4ooad.onion", "https://np.reddit.com")
		.replace("https://oauth.reddittorjg6rue252oqsxryoxengawnmo46qy4kyii5wtqnwfj4ooad.onion", "https://oauth.reddit.com")
		.replace("https://reddittorjg6rue252oqsxryoxengawnmo46qy4kyii5wtqnwfj4ooad.onion", "https://reddit.com")
		.replace(
			"https://external-preview.redditdotzhmh3mao6r5i2j7speppwqkizwo7vksy3mbz5iz7rlhocyd.onion",
			"https://external-preview.redd.it",
		)
		.replace("https://preview.redditdotzhmh3mao6r5i2j7speppwqkizwo7vksy3mbz5iz7rlhocyd.onion", "https://preview.redd.it")
		.replace("https://v.redditdotzhmh3mao6r5i2j7speppwqkizwo7vksy3mbz5iz7rlhocyd.onion", "https://v.redd.it")
		.replace("https://i.redditdotzhmh3mao6r5i2j7speppwqkizwo7vksy3mbz5iz7rlhocyd.onion", "https://i.redd.it")
		.replace("https://redditdotzhmh3mao6r5i2j7speppwqkizwo7vksy3mbz5iz7rlhocyd.onion", "https://redd.it")
}

pub(crate) fn strip_known_base(url: &str) -> &str {
	[
		OAUTH_REDDIT_BASE,
		OAUTH_REDDIT_ONION_BASE,
		WWW_REDDIT_BASE,
		WWW_REDDIT_ONION_BASE,
		SHORT_REDDIT_BASE,
		SHORT_REDDIT_ONION_BASE,
	]
	.into_iter()
	.find_map(|base| url.strip_prefix(base))
	.unwrap_or(url)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn rewrites_clearnet_reddit_urls_to_onion_urls() {
		assert_eq!(
			to_onion_url_for("https://oauth.reddit.com/r/rust/about.json", true),
			"https://oauth.reddittorjg6rue252oqsxryoxengawnmo46qy4kyii5wtqnwfj4ooad.onion/r/rust/about.json"
		);
		assert_eq!(
			to_onion_url_for("https://v.redd.it/abc/DASH_720.mp4", true),
			"https://v.redditdotzhmh3mao6r5i2j7speppwqkizwo7vksy3mbz5iz7rlhocyd.onion/abc/DASH_720.mp4"
		);
		assert_eq!(
			to_onion_url_for("https://a.thumbs.redditmedia.com/thumb.jpg", true),
			"https://a.thumbs.reddit4hkhcpcf2mkmuotdlk3gknuzcatsw4f7dx7twdkwmtrt6ax4qd.onion/thumb.jpg"
		);
	}

	#[test]
	fn leaves_urls_alone_when_onion_mode_is_disabled() {
		let url = "https://oauth.reddit.com/r/rust/about.json";
		assert_eq!(to_onion_url_for(url, false), url);
	}

	#[test]
	fn strips_clearnet_and_onion_reddit_bases() {
		assert_eq!(strip_known_base("https://www.reddit.com/r/rust"), "/r/rust");
		assert_eq!(
			strip_known_base("https://www.reddittorjg6rue252oqsxryoxengawnmo46qy4kyii5wtqnwfj4ooad.onion/r/rust"),
			"/r/rust"
		);
	}
}
