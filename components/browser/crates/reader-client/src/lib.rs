use anyhow::{Context, Result, bail};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use url::Url;

#[derive(Clone)]
pub struct SearchClient {
    client: Client,
    endpoint: Url,
    cache: Arc<Mutex<HashMap<String, CacheEntry>>>,
    cache_ttl: Duration,
}

#[derive(Clone)]
struct CacheEntry {
    stored_at: Instant,
    response: SearchResponse,
}

#[derive(Clone)]
pub struct ReaderClient {
    client: Client,
    endpoint: Url,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub query: String,
    #[serde(default = "default_search_limit")]
    pub limit: usize,
    #[serde(default)]
    pub domains: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub freshness: Option<Freshness>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Freshness {
    Day,
    Week,
    Month,
    Year,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub query: String,
    pub results: Vec<SearchResult>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    #[serde(default)]
    pub engines: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadRequest {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default = "default_read_view")]
    pub view: ReadView,
    #[serde(default = "default_max_chars")]
    pub max_chars: usize,
    #[serde(default)]
    pub require_markdown: bool,
    #[serde(default)]
    pub allow_llms_full: bool,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReadView {
    #[default]
    Main,
    Outline,
    Raw,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResponse {
    pub url: String,
    pub title: String,
    pub media_type: String,
    pub content: String,
    pub source: ReadSource,
    pub truncated: bool,
    #[serde(default)]
    pub metadata: BTreeMap<String, serde_json::Value>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReadSource {
    MarkdownNegotiation,
    MarkdownFallback,
    LlmsTxt,
    Trafilatura,
    Lightpanda,
    Chromium,
    Raw,
}

fn default_search_limit() -> usize { 8 }
fn default_max_chars() -> usize { 20_000 }
fn default_read_view() -> ReadView { ReadView::Main }

impl SearchClient {
    pub fn new(endpoint: Url) -> Result<Self> {
        let client = client_with_optional_timeout("PI_WEB_SEARCH_TIMEOUT_MS")?;
        Ok(Self {
            client,
            endpoint,
            cache: Arc::new(Mutex::new(HashMap::new())),
            cache_ttl: Duration::from_secs(45),
        })
    }

    pub fn with_cache_ttl(mut self, cache_ttl: Duration) -> Self {
        self.cache_ttl = cache_ttl;
        self
    }

    pub async fn query(&self, request: SearchQuery) -> Result<SearchResponse> {
        let cache_key = serde_json::to_string(&request)?;
        if let Some(response) = self.cache.lock().ok().and_then(|cache| {
            cache.get(&cache_key).filter(|entry| entry.stored_at.elapsed() <= self.cache_ttl).map(|entry| entry.response.clone())
        }) {
            return Ok(response);
        }

        let mut endpoint = self.endpoint.join("search")?;
        {
            let mut query = endpoint.query_pairs_mut();
            query.append_pair("q", &request.query).append_pair("format", "json");
            if let Some(range) = request.freshness {
                query.append_pair("time_range", match range {
                    Freshness::Day => "day", Freshness::Week => "week",
                    Freshness::Month => "month", Freshness::Year => "year",
                });
            }
        }
        let response = self.client.get(endpoint).send().await?.error_for_status()?;
        let body: SearxResponse = response.json().await.context("decode SearXNG JSON response")?;
        let domains: HashSet<String> = request.domains.into_iter().map(|value| value.to_ascii_lowercase()).collect();
        let mut seen = HashSet::new();
        let mut results = Vec::new();
        for item in body.results {
            let Some(normalized) = normalize_url(&item.url) else { continue; };
            let parsed = Url::parse(&normalized).ok();
            if !domains.is_empty() && !parsed.as_ref().and_then(Url::host_str).is_some_and(|host| domains.iter().any(|domain| host == domain || host.ends_with(&format!(".{domain}")))) {
                continue;
            }
            if !seen.insert(normalized.clone()) { continue; }
            results.push(SearchResult {
                title: item.title.unwrap_or_default(),
                url: normalized,
                snippet: item.content.unwrap_or_default(),
                engines: item.engines.unwrap_or_default(),
                published_at: item.published_date,
            });
            if results.len() >= request.limit.clamp(1, 20) { break; }
        }
        let response = SearchResponse { query: request.query, results };
        if let Ok(mut cache) = self.cache.lock() {
            cache.retain(|_, entry| entry.stored_at.elapsed() <= self.cache_ttl);
            if cache.len() >= 256 {
                if let Some(oldest) = cache.iter().min_by_key(|(_, entry)| entry.stored_at).map(|(key, _)| key.clone()) {
                    cache.remove(&oldest);
                }
            }
            cache.insert(cache_key, CacheEntry { stored_at: Instant::now(), response: response.clone() });
        }
        Ok(response)
    }
}

impl ReaderClient {
    pub fn new(endpoint: Url) -> Result<Self> {
        let client = client_with_optional_timeout("PI_WEB_READER_TIMEOUT_MS")?;
        Ok(Self { client, endpoint })
    }

    pub async fn read(&self, request: ReadRequest) -> Result<ReadResponse> {
        self.client
            .post(self.endpoint.join("v1/read")?)
            .json(&request)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await
            .context("decode reader response")
    }

    pub async fn health(&self) -> Result<serde_json::Value> {
        Ok(self.client.get(self.endpoint.join("health")?).send().await?.error_for_status()?.json().await?)
    }
}

fn client_with_optional_timeout(variable: &str) -> Result<Client> {
    let mut builder = Client::builder();
    if let Some(milliseconds) = std::env::var(variable)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
    {
        builder = builder.timeout(Duration::from_millis(milliseconds));
    }
    Ok(builder.build()?)
}

#[derive(Debug, Deserialize)]
struct SearxResponse {
    #[serde(default)]
    results: Vec<SearxItem>,
}

#[derive(Debug, Deserialize)]
struct SearxItem {
    title: Option<String>,
    url: String,
    content: Option<String>,
    engines: Option<Vec<String>>,
    published_date: Option<String>,
}

pub fn normalize_url(input: &str) -> Option<String> {
    let mut url = Url::parse(input).ok()?;
    if !matches!(url.scheme(), "http" | "https") { return None; }
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| !is_tracking_parameter(key.as_ref()))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    url.set_query(None);
    if !kept.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in kept { pairs.append_pair(&key, &value); }
    }
    url.set_fragment(None);
    Some(url.to_string())
}

fn is_tracking_parameter(key: &str) -> bool {
    key.starts_with("utm_") || matches!(key, "fbclid" | "gclid" | "dclid" | "mc_cid" | "mc_eid")
}

pub fn require_http_url(value: &str) -> Result<Url> {
    let url = Url::parse(value)?;
    if !matches!(url.scheme(), "http" | "https") { bail!("unsupported URL scheme: {}", url.scheme()); }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_tracking_without_dropping_real_query() {
        assert_eq!(
            normalize_url("https://example.com/a?utm_source=x&q=rust#top").unwrap(),
            "https://example.com/a?q=rust"
        );
    }
}
