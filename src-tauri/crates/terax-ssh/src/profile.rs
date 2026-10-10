use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{Result, SshError};

pub const DEFAULT_PORT: u16 = 22;
pub const DEFAULT_KEEPALIVE_SECS: u32 = 30;
const MAX_KEEPALIVE_SECS: u32 = 3600;
const MAX_TAGS: usize = 16;
const MAX_PATH_LEN: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AuthMethod {
    Agent,
    KeyFile { path: String },
    Password,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProfileSource {
    #[default]
    Manual,
    SshConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProfile {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub user: String,
    pub auth: AuthMethod,
    #[serde(default)]
    pub jump_host: Option<String>,
    #[serde(default = "default_keepalive")]
    pub keepalive_secs: u32,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub default_remote_dir: Option<String>,
    #[serde(default)]
    pub default_local_dir: Option<String>,
    #[serde(default)]
    pub source: ProfileSource,
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

fn default_keepalive() -> u32 {
    DEFAULT_KEEPALIVE_SECS
}

fn has_control(value: &str) -> bool {
    value.chars().any(|c| c.is_control())
}

pub fn validate_host(host: &str) -> Result<()> {
    if host.is_empty() || host.len() > 253 {
        return Err(SshError::invalid("host must be 1 to 253 characters"));
    }
    if host.starts_with('-') {
        return Err(SshError::invalid("host must not start with a dash"));
    }
    let ok = host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '%'));
    if !ok {
        return Err(SshError::invalid(
            "host may contain only letters, digits and . - _ : %",
        ));
    }
    Ok(())
}

pub fn validate_user(user: &str) -> Result<()> {
    if user.is_empty() || user.len() > 64 {
        return Err(SshError::invalid("user must be 1 to 64 characters"));
    }
    if user.starts_with('-') {
        return Err(SshError::invalid("user must not start with a dash"));
    }
    let ok = user
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+' | '@'));
    if !ok {
        return Err(SshError::invalid(
            "user may contain only letters, digits and . _ - + @",
        ));
    }
    Ok(())
}

fn validate_path_field(label: &str, value: &str) -> Result<()> {
    if value.is_empty() {
        return Err(SshError::invalid(format!("{label} must not be empty")));
    }
    if value.len() > MAX_PATH_LEN || value.contains('\0') {
        return Err(SshError::invalid(format!("{label} is not a valid path")));
    }
    Ok(())
}

fn validate_color(color: &str) -> Result<()> {
    let hex = color.len() == 7
        && color.starts_with('#')
        && color[1..].chars().all(|c| c.is_ascii_hexdigit());
    let word = !color.is_empty()
        && color.len() <= 16
        && color.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if hex || word {
        Ok(())
    } else {
        Err(SshError::invalid("color must be #rrggbb or a short name"))
    }
}

fn validate_id(id: &str) -> Result<()> {
    let ok = (8..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(SshError::invalid("profile id is malformed"))
    }
}

impl SshProfile {
    /// Checks every field. The id may be empty for a profile that has not been stored yet.
    pub fn validate(&self) -> Result<()> {
        if !self.id.is_empty() {
            validate_id(&self.id)?;
        }
        let name = self.name.trim();
        if name.is_empty() || name.chars().count() > 80 || has_control(name) {
            return Err(SshError::invalid("name must be 1 to 80 printable characters"));
        }
        validate_host(&self.host)?;
        validate_user(&self.user)?;
        if self.port == 0 {
            return Err(SshError::invalid("port must be between 1 and 65535"));
        }
        if self.keepalive_secs > MAX_KEEPALIVE_SECS {
            return Err(SshError::invalid("keepalive must be at most 3600 seconds"));
        }
        if let AuthMethod::KeyFile { path } = &self.auth {
            validate_path_field("key path", path)?;
        }
        if let Some(jump) = &self.jump_host {
            validate_id(jump)?;
            if jump == &self.id {
                return Err(SshError::invalid("a profile cannot jump through itself"));
            }
        }
        if let Some(color) = &self.color {
            validate_color(color)?;
        }
        if self.tags.len() > MAX_TAGS {
            return Err(SshError::invalid("at most 16 tags are allowed"));
        }
        for tag in &self.tags {
            let tag = tag.trim();
            if tag.is_empty() || tag.chars().count() > 32 || has_control(tag) {
                return Err(SshError::invalid("tags must be 1 to 32 printable characters"));
            }
        }
        for (label, dir) in [
            ("remote directory", &self.default_remote_dir),
            ("local directory", &self.default_local_dir),
        ] {
            if let Some(dir) = dir {
                validate_path_field(label, dir)?;
            }
        }
        Ok(())
    }

    pub fn normalized(mut self) -> Self {
        self.name = self.name.trim().to_string();
        self.host = self.host.trim().to_string();
        self.user = self.user.trim().to_string();
        let mut tags: Vec<String> = Vec::new();
        for tag in self.tags.drain(..) {
            let tag = tag.trim().to_string();
            if !tag.is_empty() && !tags.contains(&tag) {
                tags.push(tag);
            }
        }
        self.tags = tags;
        self
    }
}

pub fn expand_tilde(path: &str) -> PathBuf {
    if path == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(path));
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

fn jump_spec(jump: &SshProfile) -> String {
    let host = if jump.host.contains(':') {
        format!("[{}]", jump.host)
    } else {
        jump.host.clone()
    };
    format!("{}@{}:{}", jump.user, host, jump.port)
}

/// Arguments for the system `ssh` binary that open an interactive session for `profile`.
/// Every value comes from a validated profile, and none can start with a dash,
/// so a hostile profile cannot smuggle in an ssh option.
pub fn terminal_args(profile: &SshProfile, jump: Option<&SshProfile>) -> Result<Vec<String>> {
    profile.validate()?;
    let mut args = Vec::new();
    if profile.port != DEFAULT_PORT {
        args.push("-p".to_string());
        args.push(profile.port.to_string());
    }
    if let AuthMethod::KeyFile { path } = &profile.auth {
        args.push("-i".to_string());
        args.push(expand_tilde(path).to_string_lossy().into_owned());
        args.push("-o".to_string());
        args.push("IdentitiesOnly=yes".to_string());
    }
    if profile.keepalive_secs > 0 {
        args.push("-o".to_string());
        args.push(format!("ServerAliveInterval={}", profile.keepalive_secs));
    }
    if let Some(jump) = jump {
        jump.validate()?;
        if jump.jump_host.is_some() {
            return Err(SshError::invalid(
                "a jump host cannot itself use another jump host",
            ));
        }
        args.push("-J".to_string());
        args.push(jump_spec(jump));
    }
    args.push(format!("{}@{}", profile.user, profile.host));
    Ok(args)
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    pub fn profile(id: &str, name: &str) -> SshProfile {
        SshProfile {
            id: id.to_string(),
            name: name.to_string(),
            host: "example.com".to_string(),
            port: 22,
            user: "deploy".to_string(),
            auth: AuthMethod::Agent,
            jump_host: None,
            keepalive_secs: DEFAULT_KEEPALIVE_SECS,
            color: None,
            tags: vec![],
            favorite: false,
            default_remote_dir: None,
            default_local_dir: None,
            source: ProfileSource::Manual,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::profile;
    use super::*;

    #[test]
    fn a_plain_profile_is_valid() {
        profile("abcdef12", "Prod").validate().unwrap();
    }

    #[test]
    fn rejects_hosts_and_users_that_could_become_ssh_options() {
        for bad in ["-oProxyCommand=x", "-p", "", "a b", "a;b", "a$(x)", "host/../x", "a\nb"] {
            let mut p = profile("abcdef12", "x");
            p.host = bad.to_string();
            assert!(p.validate().is_err(), "host {bad:?} should be rejected");
        }
        for bad in ["-l", "", "a b", "a;b", "a`b`", "a\nb"] {
            let mut p = profile("abcdef12", "x");
            p.user = bad.to_string();
            assert!(p.validate().is_err(), "user {bad:?} should be rejected");
        }
    }

    #[test]
    fn accepts_ipv6_dns_and_email_style_users() {
        let mut p = profile("abcdef12", "x");
        p.host = "fe80::1%eth0".to_string();
        p.user = "me@corp.example".to_string();
        p.validate().unwrap();
        p.host = "build-01.internal_net.example".to_string();
        p.validate().unwrap();
    }

    #[test]
    fn rejects_bad_numeric_and_structural_fields() {
        let mut p = profile("abcdef12", "x");
        p.port = 0;
        assert!(p.validate().is_err());
        p.port = 22;
        p.keepalive_secs = 3601;
        assert!(p.validate().is_err());
        p.keepalive_secs = 30;
        p.jump_host = Some("abcdef12".to_string());
        assert!(p.validate().is_err());
        p.jump_host = Some("../etc".to_string());
        assert!(p.validate().is_err());
        p.jump_host = None;
        p.tags = (0..17).map(|i| format!("t{i}")).collect();
        assert!(p.validate().is_err());
        p.tags = vec![];
        p.color = Some("red; drop".to_string());
        assert!(p.validate().is_err());
        p.color = Some("#a1B2c3".to_string());
        p.validate().unwrap();
        p.name = "   ".to_string();
        assert!(p.validate().is_err());
    }

    #[test]
    fn key_path_must_be_a_usable_path() {
        let mut p = profile("abcdef12", "x");
        p.auth = AuthMethod::KeyFile { path: String::new() };
        assert!(p.validate().is_err());
        p.auth = AuthMethod::KeyFile { path: "a\0b".to_string() };
        assert!(p.validate().is_err());
        p.auth = AuthMethod::KeyFile { path: "~/.ssh/id_ed25519".to_string() };
        p.validate().unwrap();
    }

    #[test]
    fn empty_id_is_allowed_for_unsaved_profiles_but_bad_ids_are_not() {
        profile("", "x").validate().unwrap();
        assert!(profile("short", "x").validate().is_err());
        assert!(profile("ABCDEFGH", "x").validate().is_err());
    }

    #[test]
    fn terminal_args_are_minimal_for_the_default_case() {
        let mut p = profile("abcdef12", "x");
        p.keepalive_secs = 0;
        assert_eq!(terminal_args(&p, None).unwrap(), vec!["deploy@example.com"]);
    }

    #[test]
    fn terminal_args_include_port_key_keepalive_and_jump() {
        let mut p = profile("abcdef12", "x");
        p.port = 2222;
        p.auth = AuthMethod::KeyFile { path: "/keys/id".to_string() };
        let mut jump = profile("fedcba98", "bastion");
        jump.host = "2001:db8::1".to_string();
        jump.port = 2200;
        jump.user = "ops".to_string();
        let args = terminal_args(&p, Some(&jump)).unwrap();
        assert_eq!(
            args,
            vec![
                "-p",
                "2222",
                "-i",
                "/keys/id",
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                "ServerAliveInterval=30",
                "-J",
                "ops@[2001:db8::1]:2200",
                "deploy@example.com",
            ]
        );
    }

    #[test]
    fn terminal_args_refuse_chained_jump_hosts_and_invalid_profiles() {
        let p = profile("abcdef12", "x");
        let mut jump = profile("fedcba98", "bastion");
        jump.jump_host = Some("12345678".to_string());
        assert!(terminal_args(&p, Some(&jump)).is_err());
        let mut bad = profile("abcdef12", "x");
        bad.host = "-oProxyCommand=evil".to_string();
        assert!(terminal_args(&bad, None).is_err());
    }

    #[test]
    fn expand_tilde_only_touches_a_leading_home_marker() {
        assert_eq!(expand_tilde("/abs/path"), PathBuf::from("/abs/path"));
        assert_eq!(expand_tilde("rel/~/x"), PathBuf::from("rel/~/x"));
        if let Some(home) = dirs::home_dir() {
            assert_eq!(expand_tilde("~/a/b"), home.join("a/b"));
            assert_eq!(expand_tilde("~"), home);
        }
    }

    #[test]
    fn json_uses_camel_case_and_tagged_auth() {
        let mut p = profile("abcdef12", "x");
        p.auth = AuthMethod::KeyFile { path: "/k".to_string() };
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["keepaliveSecs"], 30);
        assert_eq!(json["auth"]["kind"], "keyFile");
        assert_eq!(json["source"], "manual");
        let back: SshProfile = serde_json::from_value(json).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn missing_optional_fields_use_defaults() {
        let p: SshProfile = serde_json::from_str(
            r#"{"name":"n","host":"h","user":"u","auth":{"kind":"password"}}"#,
        )
        .unwrap();
        assert_eq!(p.port, 22);
        assert_eq!(p.keepalive_secs, 30);
        assert!(p.id.is_empty());
        assert_eq!(p.source, ProfileSource::Manual);
    }
}
