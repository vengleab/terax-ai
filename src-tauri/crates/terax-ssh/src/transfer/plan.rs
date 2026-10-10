//! Expands the selected sources into the folders to create and the files to copy.
//!
//! Selected items are resolved through symlinks. Symlinks found while walking a folder are
//! skipped, never followed, so a link cannot pull in files from outside the selection or loop.

use serde::Serialize;

use crate::error::{Result, SshError};
use crate::fs::{EntryKind, Fs};
use crate::transfer::safety::check_component;

const MAX_ENTRIES: usize = 200_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanOp {
    Mkdir {
        dst: String,
    },
    Copy {
        item: usize,
        src: String,
        dst: String,
        size: u64,
        mtime: Option<i64>,
        mode: Option<u32>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedItem {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanItem {
    pub source: String,
    pub dst: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Plan {
    pub items: Vec<PlanItem>,
    pub ops: Vec<PlanOp>,
    pub skipped: Vec<SkippedItem>,
    pub files: u64,
    pub bytes: u64,
}

fn is_inside(parent: &str, child: &str) -> bool {
    let parent = parent.trim_end_matches('/');
    child == parent || child.starts_with(&format!("{parent}/"))
}

pub async fn build(
    src: &Fs,
    dst: &Fs,
    sources: &[String],
    dst_dir: &str,
) -> Result<Plan> {
    let windows_rules = dst.is_local() && cfg!(windows);
    let mut plan = Plan::default();
    let mut entries = 0usize;

    for source in sources {
        let name = src.file_name(source);
        if let Err(reason) = check_component(&name, windows_rules) {
            plan.skipped.push(SkippedItem {
                path: source.clone(),
                reason: reason.to_string(),
            });
            continue;
        }
        let stat = match src.stat(source, true).await {
            Ok(stat) => stat,
            Err(err) => {
                plan.skipped.push(SkippedItem {
                    path: source.clone(),
                    reason: err.message,
                });
                continue;
            }
        };
        let dst_path = dst.join(dst_dir, &name);
        let item = plan.items.len();

        match stat.kind {
            EntryKind::File => {
                plan.items.push(PlanItem { source: source.clone(), dst: dst_path.clone(), is_dir: false });
                plan.files += 1;
                plan.bytes += stat.size;
                plan.ops.push(PlanOp::Copy {
                    item,
                    src: source.clone(),
                    dst: dst_path,
                    size: stat.size,
                    mtime: stat.mtime,
                    mode: stat.mode,
                });
            }
            EntryKind::Dir => {
                if src.same_endpoint(dst) && is_inside(source, dst_dir) {
                    return Err(SshError::invalid(format!(
                        "cannot copy {name} into itself"
                    )));
                }
                plan.items.push(PlanItem { source: source.clone(), dst: dst_path.clone(), is_dir: true });
                plan.ops.push(PlanOp::Mkdir { dst: dst_path.clone() });
                let mut stack = vec![(source.clone(), dst_path)];
                while let Some((src_dir, dst_dir)) = stack.pop() {
                    for entry in src.list(&src_dir).await? {
                        entries += 1;
                        if entries > MAX_ENTRIES {
                            return Err(SshError::invalid(
                                "too many files in one transfer, copy them in smaller batches",
                            ));
                        }
                        if let Err(reason) = check_component(&entry.name, windows_rules) {
                            plan.skipped.push(SkippedItem {
                                path: entry.path,
                                reason: reason.to_string(),
                            });
                            continue;
                        }
                        let child_dst = dst.join(&dst_dir, &entry.name);
                        match entry.kind {
                            EntryKind::Dir => {
                                plan.ops.push(PlanOp::Mkdir { dst: child_dst.clone() });
                                stack.push((entry.path, child_dst));
                            }
                            EntryKind::File => {
                                plan.files += 1;
                                plan.bytes += entry.size;
                                plan.ops.push(PlanOp::Copy {
                                    item,
                                    src: entry.path,
                                    dst: child_dst,
                                    size: entry.size,
                                    mtime: entry.mtime,
                                    mode: entry.mode,
                                });
                            }
                            EntryKind::Symlink => plan.skipped.push(SkippedItem {
                                path: entry.path,
                                reason: "symbolic links inside folders are not followed".to_string(),
                            }),
                            EntryKind::Other => plan.skipped.push(SkippedItem {
                                path: entry.path,
                                reason: "special files are not copied".to_string(),
                            }),
                        }
                    }
                }
            }
            EntryKind::Symlink | EntryKind::Other => plan.skipped.push(SkippedItem {
                path: source.clone(),
                reason: "not a regular file or folder".to_string(),
            }),
        }
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn p(dir: &tempfile::TempDir, rel: &str) -> String {
        let base = dir.path().to_string_lossy().replace('\\', "/");
        if rel.is_empty() {
            base
        } else {
            format!("{base}/{rel}")
        }
    }

    #[tokio::test]
    async fn expands_folders_into_mkdirs_and_copies() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        fs::create_dir_all(src.path().join("proj/sub")).unwrap();
        fs::write(src.path().join("proj/a.txt"), b"12345").unwrap();
        fs::write(src.path().join("proj/sub/b.txt"), b"123").unwrap();
        fs::write(src.path().join("single.txt"), b"1234567").unwrap();

        let plan = build(
            &Fs::Local,
            &Fs::Local,
            &[p(&src, "proj"), p(&src, "single.txt")],
            &p(&dst, ""),
        )
        .await
        .unwrap();

        assert_eq!(plan.files, 3);
        assert_eq!(plan.bytes, 15);
        assert_eq!(plan.items.len(), 2);
        assert!(plan.items[0].is_dir && !plan.items[1].is_dir);
        let mkdirs: Vec<_> = plan
            .ops
            .iter()
            .filter_map(|op| match op {
                PlanOp::Mkdir { dst } => Some(dst.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(mkdirs.len(), 2);
        assert!(mkdirs[0].ends_with("/proj"));
        assert!(mkdirs[1].ends_with("/proj/sub"));
        let copies = plan.ops.iter().filter(|op| matches!(op, PlanOp::Copy { .. })).count();
        assert_eq!(copies, 3);
    }

    #[tokio::test]
    async fn parents_are_created_before_children() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        fs::create_dir_all(src.path().join("a/b/c")).unwrap();
        let plan = build(&Fs::Local, &Fs::Local, &[p(&src, "a")], &p(&dst, "")).await.unwrap();
        let order: Vec<_> = plan
            .ops
            .iter()
            .filter_map(|op| match op {
                PlanOp::Mkdir { dst } => Some(dst.rsplit('/').next().unwrap().to_string()),
                _ => None,
            })
            .collect();
        assert_eq!(order, vec!["a", "b", "c"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinks_inside_folders_are_skipped_not_followed() {
        let src = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), b"x").unwrap();
        fs::create_dir(src.path().join("proj")).unwrap();
        fs::write(src.path().join("proj/ok.txt"), b"x").unwrap();
        std::os::unix::fs::symlink(outside.path(), src.path().join("proj/escape")).unwrap();
        std::os::unix::fs::symlink(src.path().join("proj"), src.path().join("proj/loop")).unwrap();

        let plan = build(&Fs::Local, &Fs::Local, &[p(&src, "proj")], &p(&dst, "")).await.unwrap();
        assert_eq!(plan.files, 1);
        assert_eq!(plan.skipped.len(), 2);
        assert!(plan.skipped.iter().all(|s| s.reason.contains("symbolic links")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_selected_symlink_to_a_file_is_copied_as_its_target() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        fs::write(src.path().join("real.txt"), b"hello").unwrap();
        std::os::unix::fs::symlink(src.path().join("real.txt"), src.path().join("alias.txt")).unwrap();
        let plan = build(&Fs::Local, &Fs::Local, &[p(&src, "alias.txt")], &p(&dst, "")).await.unwrap();
        assert_eq!(plan.files, 1);
        assert_eq!(plan.bytes, 5);
        assert!(plan.skipped.is_empty());
    }

    #[tokio::test]
    async fn copying_a_folder_into_itself_is_refused() {
        let src = tempfile::tempdir().unwrap();
        fs::create_dir_all(src.path().join("proj/inner")).unwrap();
        let err = build(&Fs::Local, &Fs::Local, &[p(&src, "proj")], &p(&src, "proj/inner")).await.unwrap_err();
        assert!(err.message.contains("into itself"));
        let err = build(&Fs::Local, &Fs::Local, &[p(&src, "proj")], &p(&src, "proj")).await.unwrap_err();
        assert!(err.message.contains("into itself"));
        build(&Fs::Local, &Fs::Local, &[p(&src, "proj")], &p(&src, "")).await.unwrap();
    }

    #[tokio::test]
    async fn missing_sources_are_reported_not_fatal() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        fs::write(src.path().join("here.txt"), b"x").unwrap();
        let plan = build(
            &Fs::Local,
            &Fs::Local,
            &[p(&src, "gone.txt"), p(&src, "here.txt")],
            &p(&dst, ""),
        )
        .await
        .unwrap();
        assert_eq!(plan.files, 1);
        assert_eq!(plan.skipped.len(), 1);
    }

    #[test]
    fn containment_check_is_segment_aware() {
        assert!(is_inside("/a/b", "/a/b"));
        assert!(is_inside("/a/b", "/a/b/c"));
        assert!(!is_inside("/a/b", "/a/bc"));
        assert!(is_inside("/a/b/", "/a/b/c"));
    }
}
