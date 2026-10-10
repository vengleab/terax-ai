//! Rules for names written to a destination. Remote servers choose the names we create locally,
//! so every component is checked before it is joined onto a destination path.

const MAX_NAME_BYTES: usize = 255;
const WINDOWS_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Returns the reason a file name cannot be used, or `Ok` if it is safe as one path component.
pub fn check_component(name: &str, windows_rules: bool) -> Result<(), &'static str> {
    if name.is_empty() {
        return Err("the name is empty");
    }
    if name == "." || name == ".." {
        return Err("the name is a relative path marker");
    }
    if name.len() > MAX_NAME_BYTES {
        return Err("the name is too long");
    }
    if name.contains('/') || name.contains('\0') {
        return Err("the name contains a path separator");
    }
    if name.chars().any(|c| c.is_control()) {
        return Err("the name contains control characters");
    }
    if windows_rules {
        if name.contains('\\') {
            return Err("the name contains a path separator");
        }
        if name.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')) {
            return Err("the name contains characters Windows does not allow");
        }
        if name.ends_with('.') || name.ends_with(' ') {
            return Err("Windows does not allow names ending in a dot or space");
        }
        let stem = name.split('.').next().unwrap_or(name).trim_end().to_ascii_uppercase();
        if WINDOWS_RESERVED.contains(&stem.as_str()) {
            return Err("the name is reserved on Windows");
        }
    }
    Ok(())
}

/// Candidate names for the "keep both" conflict policy: `a.txt` becomes `a (1).txt`, `a (2).txt`, ...
pub fn numbered_name(name: &str, n: u32) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 => format!("{} ({n}){}", &name[..dot], &name[dot..]),
        _ => format!("{name} ({n})"),
    }
}

pub fn part_name(name: &str) -> String {
    format!("{name}.terax-part")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_names_that_could_escape_the_destination() {
        for bad in ["", ".", "..", "a/b", "../x", "/etc/passwd", "a\0b", "line\nbreak", "tab\there"] {
            assert!(check_component(bad, false).is_err(), "{bad:?} must be rejected");
        }
        assert!(check_component(&"x".repeat(256), false).is_err());
        assert!(check_component(&"x".repeat(255), false).is_ok());
    }

    #[test]
    fn ordinary_names_pass() {
        for ok in ["file.txt", ".env", "a b", "ünïcode.md", "...", "name with (1)", "back\\slash"] {
            assert!(check_component(ok, false).is_ok(), "{ok:?} should pass on unix rules");
        }
    }

    #[test]
    fn windows_rules_are_stricter() {
        for bad in ["a\\b", "c:evil", "CON", "con.txt", "Nul.tar.gz", "LPT1", "x.", "x ", "a<b", "a|b", "a?b", "a*b", "a\"b"] {
            assert!(check_component(bad, true).is_err(), "{bad:?} must be rejected on windows");
        }
        for ok in ["console", "COM10", "file.txt", "aux_file", ".hidden"] {
            assert!(check_component(ok, true).is_ok(), "{ok:?} should pass on windows");
        }
    }

    #[test]
    fn numbering_keeps_the_extension() {
        assert_eq!(numbered_name("report.txt", 1), "report (1).txt");
        assert_eq!(numbered_name("archive.tar.gz", 2), "archive.tar (2).gz");
        assert_eq!(numbered_name(".env", 1), ".env (1)");
        assert_eq!(numbered_name("noext", 3), "noext (3)");
    }

    #[test]
    fn part_names_are_stable() {
        assert_eq!(part_name("a.bin"), "a.bin.terax-part");
    }
}
