use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Invalid,
    NotFound,
    Exists,
    PermissionDenied,
    Io,
    Connect,
    Auth,
    PasswordRequired,
    HostKeyUnknown,
    HostKeyChanged,
    PassphraseRequired,
    PassphraseInvalid,
    Protocol,
    Cancelled,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct SshError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

pub type Result<T> = std::result::Result<T, SshError>;

impl SshError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(mut self, data: serde_json::Value) -> Self {
        self.data = Some(data);
        self
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Invalid, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    pub fn exists(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Exists, message)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Io, message)
    }

    pub fn permission_denied(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::PermissionDenied, message)
    }

    pub fn connect(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Connect, message)
    }

    pub fn auth(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Auth, message)
    }

    pub fn protocol(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Protocol, message)
    }

    pub fn cancelled() -> Self {
        Self::new(ErrorCode::Cancelled, "cancelled")
    }
}

impl From<std::io::Error> for SshError {
    fn from(err: std::io::Error) -> Self {
        let code = match err.kind() {
            std::io::ErrorKind::NotFound => ErrorCode::NotFound,
            std::io::ErrorKind::AlreadyExists => ErrorCode::Exists,
            std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
            _ => ErrorCode::Io,
        };
        Self::new(code, err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_code_as_snake_case() {
        let err = SshError::new(ErrorCode::HostKeyChanged, "changed");
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "host_key_changed");
        assert_eq!(json["message"], "changed");
        assert!(json.get("data").is_none());
    }

    #[test]
    fn carries_structured_data_when_present() {
        let err = SshError::new(ErrorCode::HostKeyUnknown, "unknown")
            .with_data(serde_json::json!({ "fingerprint": "SHA256:abc" }));
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["data"]["fingerprint"], "SHA256:abc");
    }

    #[test]
    fn maps_io_error_kinds() {
        let missing: SshError = std::io::Error::from(std::io::ErrorKind::NotFound).into();
        assert_eq!(missing.code, ErrorCode::NotFound);
        let exists: SshError = std::io::Error::from(std::io::ErrorKind::AlreadyExists).into();
        assert_eq!(exists.code, ErrorCode::Exists);
        let denied: SshError = std::io::Error::from(std::io::ErrorKind::PermissionDenied).into();
        assert_eq!(denied.code, ErrorCode::PermissionDenied);
        let other: SshError = std::io::Error::from(std::io::ErrorKind::BrokenPipe).into();
        assert_eq!(other.code, ErrorCode::Io);
    }
}
