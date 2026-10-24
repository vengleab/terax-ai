use std::path::Path;

use url::Url;

/// The existing directories among the URLs the OS asked the app to open.
///
/// Anything that is not a `file:` URL, does not exist, or is a regular file is skipped (files are
/// handled by the app itself). Paths are canonicalized so a symlinked or `/tmp` style path matches
/// what the rest of the app sees, and the same folder is returned once.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn from_urls(urls: &[Url]) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for url in urls {
        let Ok(path) = url.to_file_path() else {
            continue;
        };
        let Ok(canonical) = std::fs::canonicalize(path) else {
            continue;
        };
        if !canonical.is_dir() {
            continue;
        }
        let folder = display(&canonical);
        if !found.contains(&folder) {
            found.push(folder);
        }
    }
    found
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn url(path: &std::path::Path) -> Url {
        Url::from_file_path(path).expect("absolute path")
    }

    #[test]
    fn keeps_folders_and_skips_files_missing_paths_and_other_schemes() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("project");
        fs::create_dir(&folder).unwrap();
        let file = tmp.path().join("notes.txt");
        fs::write(&file, "x").unwrap();
        let urls = vec![
            url(&folder),
            url(&file),
            url(&tmp.path().join("gone")),
            Url::parse("https://example.com/project").unwrap(),
        ];
        let canonical = fs::canonicalize(&folder).unwrap();
        assert_eq!(from_urls(&urls), vec![canonical.to_string_lossy().into_owned()]);
    }

    #[test]
    fn returns_a_folder_once_even_when_named_two_ways() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("project");
        fs::create_dir(&folder).unwrap();
        let dotted = folder.join("..").join("project");
        assert_eq!(from_urls(&[url(&folder), url(&dotted)]).len(), 1);
    }

    #[test]
    fn follows_a_symlink_to_its_target_folder() {
        #[cfg(unix)]
        {
            let tmp = tempfile::tempdir().unwrap();
            let real = tmp.path().join("real");
            fs::create_dir(&real).unwrap();
            let link = tmp.path().join("link");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            let expected = fs::canonicalize(&real).unwrap().to_string_lossy().into_owned();
            assert_eq!(from_urls(&[url(&link)]), vec![expected]);
        }
    }

    #[test]
    fn handles_percent_encoded_names_and_empty_input() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("my project (1)");
        fs::create_dir(&folder).unwrap();
        assert_eq!(from_urls(&[url(&folder)]).len(), 1);
        assert!(from_urls(&[]).is_empty());
    }
}
