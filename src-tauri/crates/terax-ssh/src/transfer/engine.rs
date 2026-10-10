//! Runs a transfer between any two file systems (local or SFTP), including server to server.
//!
//! Data streams through this process in bounded chunks, so a file is never held in memory.
//! Files are written to `<name>.terax-part` and renamed into place when complete.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::error::{ErrorCode, Result, SshError};
use crate::fs::{EntryKind, FileStat, Fs};
use crate::transfer::plan::{self, PlanOp, SkippedItem};
use crate::transfer::safety::{check_component, numbered_name, part_name};

const CHUNK: usize = 256 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const DEFAULT_CONCURRENCY: usize = 3;
const MAX_CONCURRENCY: usize = 8;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferMode {
    Copy,
    Move,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictPolicy {
    Ask,
    Overwrite,
    Skip,
    Rename,
    /// Overwrite only when the source is newer or the sizes differ.
    Update,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictDecision {
    Overwrite,
    Skip,
    Rename,
    Cancel,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    pub src_path: String,
    pub dst_path: String,
    pub src_size: u64,
    pub dst_size: u64,
    pub src_mtime: Option<i64>,
    pub dst_mtime: Option<i64>,
}

#[derive(Debug, Clone, Copy)]
pub struct Resolution {
    pub decision: ConflictDecision,
    pub apply_to_all: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TransferEvent {
    #[serde(rename_all = "camelCase")]
    Planned {
        files: u64,
        bytes: u64,
        skipped: Vec<SkippedItem>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        bytes_done: u64,
        bytes_total: u64,
        files_done: u64,
        files_total: u64,
        bytes_per_sec: u64,
        current: Vec<String>,
    },
}

pub trait TransferHooks: Send + Sync + 'static {
    fn emit(&self, event: TransferEvent);
    fn resolve_conflict(&self, info: ConflictInfo) -> BoxFuture<Resolution>;
}

#[derive(Clone)]
pub struct TransferJob {
    pub src: Fs,
    pub dst: Fs,
    pub sources: Vec<String>,
    pub dst_dir: String,
    pub mode: TransferMode,
    pub conflict: ConflictPolicy,
    pub resume: bool,
    pub concurrency: usize,
}

impl TransferJob {
    pub fn new(src: Fs, dst: Fs, sources: Vec<String>, dst_dir: String) -> Self {
        Self {
            src,
            dst,
            sources,
            dst_dir,
            mode: TransferMode::Copy,
            conflict: ConflictPolicy::Ask,
            resume: true,
            concurrency: DEFAULT_CONCURRENCY,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemError {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSummary {
    pub files_done: u64,
    pub bytes_done: u64,
    pub files_skipped: u64,
    pub moved: u64,
    pub errors: Vec<ItemError>,
    pub skipped: Vec<SkippedItem>,
    pub cancelled: bool,
}

#[derive(Default)]
struct Progress {
    bytes: AtomicU64,
    files: AtomicU64,
    active: Mutex<Vec<String>>,
}

impl Progress {
    fn add(&self, n: u64) {
        self.bytes.fetch_add(n, Ordering::Relaxed);
    }

    fn start(&self, name: &str) {
        if let Ok(mut active) = self.active.lock() {
            active.push(name.to_string());
        }
    }

    fn finish(&self, name: &str) {
        if let Ok(mut active) = self.active.lock() {
            if let Some(index) = active.iter().position(|n| n == name) {
                active.remove(index);
            }
        }
    }

    fn current(&self) -> Vec<String> {
        self.active.lock().map(|a| a.iter().take(3).cloned().collect()).unwrap_or_default()
    }
}

struct ConflictGate {
    policy: ConflictPolicy,
    sticky: tokio::sync::Mutex<Option<ConflictDecision>>,
}

impl ConflictGate {
    async fn decide(
        &self,
        info: ConflictInfo,
        hooks: &Arc<dyn TransferHooks>,
        cancel: &CancellationToken,
    ) -> ConflictDecision {
        match self.policy {
            ConflictPolicy::Overwrite => ConflictDecision::Overwrite,
            ConflictPolicy::Skip => ConflictDecision::Skip,
            ConflictPolicy::Rename => ConflictDecision::Rename,
            ConflictPolicy::Update => {
                let newer = match (info.src_mtime, info.dst_mtime) {
                    (Some(s), Some(d)) => s > d,
                    _ => true,
                };
                if newer || info.src_size != info.dst_size {
                    ConflictDecision::Overwrite
                } else {
                    ConflictDecision::Skip
                }
            }
            ConflictPolicy::Ask => {
                let mut sticky = self.sticky.lock().await;
                if let Some(decision) = *sticky {
                    return decision;
                }
                let resolution = tokio::select! {
                    _ = cancel.cancelled() => return ConflictDecision::Cancel,
                    resolution = hooks.resolve_conflict(info) => resolution,
                };
                if resolution.apply_to_all && resolution.decision != ConflictDecision::Cancel {
                    *sticky = Some(resolution.decision);
                }
                resolution.decision
            }
        }
    }
}

enum Outcome {
    Copied,
    Skipped,
}

struct Shared {
    src: Fs,
    dst: Fs,
    resume: bool,
    progress: Arc<Progress>,
    gate: Arc<ConflictGate>,
    hooks: Arc<dyn TransferHooks>,
    cancel: CancellationToken,
}

async fn unique_path(dst: &Fs, dir: &str, name: &str) -> Result<String> {
    for n in 1..=999 {
        let candidate = dst.join(dir, &numbered_name(name, n));
        if !dst.exists(&candidate).await? {
            return Ok(candidate);
        }
    }
    Err(SshError::exists("could not find a free name to keep both files"))
}

async fn pump(
    mut reader: Box<dyn crate::fs::ReadSeek>,
    mut writer: Box<dyn crate::fs::WriteSeek>,
    progress: &Progress,
    cancel: &CancellationToken,
) -> Result<u64> {
    let mut buf = vec![0u8; CHUNK];
    let mut total = 0u64;
    loop {
        let n = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(SshError::cancelled()),
            read = reader.read(&mut buf) => read?,
        };
        if n == 0 {
            break;
        }
        let chunk = buf.get(..n).unwrap_or_default();
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(SshError::cancelled()),
            written = writer.write_all(chunk) => written?,
        }
        total += n as u64;
        progress.add(n as u64);
    }
    tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(SshError::cancelled()),
        closed = writer.shutdown() => closed?,
    }
    Ok(total)
}

async fn copy_file(
    shared: &Shared,
    src_path: &str,
    dst_path: &str,
    size: u64,
    mtime: Option<i64>,
    mode: Option<u32>,
) -> Result<Outcome> {
    let dst = &shared.dst;
    let dir = dst.parent(dst_path);
    let mut final_path = dst_path.to_string();

    match dst.stat(&final_path, false).await {
        Ok(existing) => {
            if existing.kind == EntryKind::Dir {
                return Err(SshError::exists("a folder with the same name exists at the destination"));
            }
            let info = ConflictInfo {
                src_path: src_path.to_string(),
                dst_path: final_path.clone(),
                src_size: size,
                dst_size: existing.size,
                src_mtime: mtime,
                dst_mtime: existing.mtime,
            };
            match shared.gate.decide(info, &shared.hooks, &shared.cancel).await {
                ConflictDecision::Skip => return Ok(Outcome::Skipped),
                ConflictDecision::Cancel => {
                    shared.cancel.cancel();
                    return Err(SshError::cancelled());
                }
                ConflictDecision::Overwrite => {}
                ConflictDecision::Rename => {
                    final_path = unique_path(dst, &dir, &dst.file_name(&final_path)).await?;
                }
            }
        }
        Err(err) if err.code == ErrorCode::NotFound => {}
        Err(err) => return Err(err),
    }

    let part = dst.join(&dir, &part_name(&dst.file_name(&final_path)));
    let mut offset = 0u64;
    if shared.resume {
        if let Ok(stat) = dst.stat(&part, false).await {
            if stat.kind == EntryKind::File && stat.size <= size {
                offset = stat.size;
            }
        }
    }

    let label = dst.file_name(&final_path);
    shared.progress.start(&label);
    shared.progress.add(offset);
    let copied = async {
        let reader = shared.src.open_read(src_path, offset).await?;
        let writer = dst.open_write(&part, (offset > 0).then_some(offset)).await?;
        pump(reader, writer, &shared.progress, &shared.cancel).await
    }
    .await;
    shared.progress.finish(&label);

    let written = match copied {
        Ok(written) => written,
        Err(err) => {
            if !shared.resume || err.code != ErrorCode::Cancelled && err.code != ErrorCode::Io {
                let _ = dst.remove_file(&part).await;
            }
            return Err(err);
        }
    };

    let produced = offset + written;
    if produced != size {
        let _ = dst.remove_file(&part).await;
        return Err(SshError::io("the source changed while it was being copied"));
    }
    let stored: FileStat = dst.stat(&part, false).await?;
    if stored.size != size {
        let _ = dst.remove_file(&part).await;
        return Err(SshError::io("the copy is incomplete, the destination reports a different size"));
    }
    dst.rename_over(&part, &final_path).await?;
    dst.set_times_and_mode(&final_path, mtime, mode).await;
    Ok(Outcome::Copied)
}

async fn ensure_dir(dst: &Fs, path: &str) -> Result<()> {
    match dst.stat(path, true).await {
        Ok(stat) if stat.kind == EntryKind::Dir => Ok(()),
        Ok(_) => Err(SshError::exists("a file with the same name exists at the destination")),
        Err(err) if err.code == ErrorCode::NotFound => dst.mkdir_all(path).await,
        Err(err) => Err(err),
    }
}

fn spawn_ticker(
    hooks: Arc<dyn TransferHooks>,
    progress: Arc<Progress>,
    files_total: u64,
    bytes_total: u64,
    stop: CancellationToken,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(PROGRESS_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_bytes = 0u64;
        let mut last_at = Instant::now();
        let mut smoothed = 0.0f64;
        loop {
            tokio::select! {
                _ = stop.cancelled() => break,
                _ = interval.tick() => {}
            }
            let bytes = progress.bytes.load(Ordering::Relaxed);
            let now = Instant::now();
            let elapsed = now.duration_since(last_at).as_secs_f64().max(0.001);
            let instant = bytes.saturating_sub(last_bytes) as f64 / elapsed;
            smoothed = if smoothed == 0.0 { instant } else { smoothed * 0.7 + instant * 0.3 };
            last_bytes = bytes;
            last_at = now;
            hooks.emit(TransferEvent::Progress {
                bytes_done: bytes,
                bytes_total,
                files_done: progress.files.load(Ordering::Relaxed),
                files_total,
                bytes_per_sec: smoothed as u64,
                current: progress.current(),
            });
        }
    })
}

async fn fast_moves(
    job: &TransferJob,
    gate: &ConflictGate,
    hooks: &Arc<dyn TransferHooks>,
    cancel: &CancellationToken,
    summary: &mut TransferSummary,
) -> Vec<String> {
    let mut fallback = Vec::new();
    let windows_rules = job.dst.is_local() && cfg!(windows);
    for source in &job.sources {
        if cancel.is_cancelled() {
            summary.cancelled = true;
            break;
        }
        let name = job.src.file_name(source);
        if let Err(reason) = check_component(&name, windows_rules) {
            summary.skipped.push(SkippedItem { path: source.clone(), reason: reason.to_string() });
            continue;
        }
        let mut target = job.dst.join(&job.dst_dir, &name);
        if &target == source {
            continue;
        }
        let stat = match job.src.stat(source, false).await {
            Ok(stat) => stat,
            Err(err) => {
                summary.errors.push(ItemError { path: source.clone(), message: err.message });
                continue;
            }
        };
        if stat.kind == EntryKind::Dir && (target.starts_with(&format!("{}/", source.trim_end_matches('/')))) {
            summary.errors.push(ItemError { path: source.clone(), message: format!("cannot move {name} into itself") });
            continue;
        }
        let mut replace = false;
        if let Ok(existing) = job.dst.stat(&target, false).await {
            let info = ConflictInfo {
                src_path: source.clone(),
                dst_path: target.clone(),
                src_size: stat.size,
                dst_size: existing.size,
                src_mtime: stat.mtime,
                dst_mtime: existing.mtime,
            };
            match gate.decide(info, hooks, cancel).await {
                ConflictDecision::Skip => {
                    summary.files_skipped += 1;
                    continue;
                }
                ConflictDecision::Cancel => {
                    cancel.cancel();
                    summary.cancelled = true;
                    break;
                }
                ConflictDecision::Overwrite => replace = true,
                ConflictDecision::Rename => match unique_path(&job.dst, &job.dst_dir, &name).await {
                    Ok(path) => target = path,
                    Err(err) => {
                        summary.errors.push(ItemError { path: source.clone(), message: err.message });
                        continue;
                    }
                },
            }
            if replace && existing.kind == EntryKind::Dir {
                summary.errors.push(ItemError { path: target.clone(), message: "a folder with the same name exists at the destination".to_string() });
                continue;
            }
        }
        let renamed = if replace {
            job.dst.rename_over(source, &target).await
        } else {
            job.src.rename(source, &target).await
        };
        match renamed {
            Ok(()) => summary.moved += 1,
            Err(_) => fallback.push(source.clone()),
        }
    }
    fallback
}

/// Runs the transfer. Failures of single files are collected in the summary, not returned.
pub async fn run(
    job: TransferJob,
    hooks: Arc<dyn TransferHooks>,
    cancel: CancellationToken,
) -> Result<TransferSummary> {
    let mut summary = TransferSummary::default();
    let gate = Arc::new(ConflictGate {
        policy: job.conflict,
        sticky: tokio::sync::Mutex::new(None),
    });

    let mut remaining = job.sources.clone();
    if job.mode == TransferMode::Move && job.src.same_endpoint(&job.dst) {
        remaining = fast_moves(&job, &gate, &hooks, &cancel, &mut summary).await;
        if remaining.is_empty() || summary.cancelled {
            return Ok(summary);
        }
    }

    let plan = plan::build(&job.src, &job.dst, &remaining, &job.dst_dir).await?;
    summary.skipped = std::mem::take(&mut summary.skipped).into_iter().chain(plan.skipped.clone()).collect();
    hooks.emit(TransferEvent::Planned {
        files: plan.files,
        bytes: plan.bytes,
        skipped: plan.skipped.clone(),
    });

    let progress = Arc::new(Progress::default());
    let stop_ticker = CancellationToken::new();
    let ticker = spawn_ticker(hooks.clone(), progress.clone(), plan.files, plan.bytes, stop_ticker.clone());

    let mut item_ok = vec![true; plan.items.len()];
    for op in &plan.ops {
        if let PlanOp::Mkdir { dst } = op {
            if cancel.is_cancelled() {
                break;
            }
            if let Err(err) = ensure_dir(&job.dst, dst).await {
                summary.errors.push(ItemError { path: dst.clone(), message: err.message });
                for (index, item) in plan.items.iter().enumerate() {
                    if dst == &item.dst || dst.starts_with(&format!("{}/", item.dst)) {
                        item_ok[index] = false;
                    }
                }
            }
        }
    }

    let shared = Arc::new(Shared {
        src: job.src.clone(),
        dst: job.dst.clone(),
        resume: job.resume,
        progress: progress.clone(),
        gate: gate.clone(),
        hooks: hooks.clone(),
        cancel: cancel.clone(),
    });
    let permits = Arc::new(Semaphore::new(job.concurrency.clamp(1, MAX_CONCURRENCY)));
    let mut set: JoinSet<(usize, String, Result<Outcome>)> = JoinSet::new();

    for op in plan.ops.iter().cloned() {
        let PlanOp::Copy { item, src, dst, size, mtime, mode } = op else {
            continue;
        };
        if !item_ok.get(item).copied().unwrap_or(false) {
            continue;
        }
        let permit = tokio::select! {
            _ = cancel.cancelled() => break,
            permit = permits.clone().acquire_owned() => match permit {
                Ok(permit) => permit,
                Err(_) => break,
            },
        };
        let shared = shared.clone();
        set.spawn(async move {
            let result = copy_file(&shared, &src, &dst, size, mtime, mode).await;
            if matches!(result, Ok(Outcome::Copied)) {
                shared.progress.files.fetch_add(1, Ordering::Relaxed);
            }
            drop(permit);
            (item, src, result)
        });
    }

    while let Some(joined) = set.join_next().await {
        match joined {
            Ok((item, src, result)) => match result {
                Ok(Outcome::Copied) => summary.files_done += 1,
                Ok(Outcome::Skipped) => {
                    summary.files_skipped += 1;
                    if let Some(ok) = item_ok.get_mut(item) {
                        *ok = false;
                    }
                }
                Err(err) if err.code == ErrorCode::Cancelled => {
                    summary.cancelled = true;
                    if let Some(ok) = item_ok.get_mut(item) {
                        *ok = false;
                    }
                }
                Err(err) => {
                    summary.errors.push(ItemError { path: src, message: err.message });
                    if let Some(ok) = item_ok.get_mut(item) {
                        *ok = false;
                    }
                }
            },
            Err(join_error) => summary.errors.push(ItemError {
                path: String::new(),
                message: format!("a transfer task failed: {join_error}"),
            }),
        }
    }
    if cancel.is_cancelled() {
        summary.cancelled = true;
    }

    stop_ticker.cancel();
    let _ = ticker.await;
    summary.bytes_done = progress.bytes.load(Ordering::Relaxed);
    hooks.emit(TransferEvent::Progress {
        bytes_done: summary.bytes_done,
        bytes_total: plan.bytes,
        files_done: summary.files_done,
        files_total: plan.files,
        bytes_per_sec: 0,
        current: Vec::new(),
    });

    if job.mode == TransferMode::Move && !summary.cancelled {
        for (index, item) in plan.items.iter().enumerate() {
            let untouched = plan.skipped.iter().any(|s| {
                s.path == item.source || s.path.starts_with(&format!("{}/", item.source.trim_end_matches('/')))
            });
            if !item_ok[index] || untouched {
                continue;
            }
            match job.src.remove_all(&item.source).await {
                Ok(()) => summary.moved += 1,
                Err(err) => summary.errors.push(ItemError {
                    path: item.source.clone(),
                    message: format!("copied, but the original could not be removed: {}", err.message),
                }),
            }
        }
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{context, password_spec, trust, Opts, TestServer};
    use crate::session::SshSession;
    use std::collections::VecDeque;
    use std::fs;
    use std::sync::atomic::AtomicUsize;

    struct Hooks {
        events: Mutex<Vec<TransferEvent>>,
        answers: Mutex<VecDeque<Resolution>>,
        asked: AtomicUsize,
        cancel_on_progress: Option<(u64, CancellationToken)>,
    }

    impl Hooks {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                events: Mutex::new(Vec::new()),
                answers: Mutex::new(VecDeque::new()),
                asked: AtomicUsize::new(0),
                cancel_on_progress: None,
            })
        }

        fn answering(answers: Vec<Resolution>) -> Arc<Self> {
            let hooks = Self::new();
            *hooks.answers.lock().unwrap() = answers.into();
            hooks
        }

        fn cancelling(after_bytes: u64, token: CancellationToken) -> Arc<Self> {
            Arc::new(Self {
                events: Mutex::new(Vec::new()),
                answers: Mutex::new(VecDeque::new()),
                asked: AtomicUsize::new(0),
                cancel_on_progress: Some((after_bytes, token)),
            })
        }

        fn progress_bytes(&self) -> Vec<u64> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter_map(|e| match e {
                    TransferEvent::Progress { bytes_done, .. } => Some(*bytes_done),
                    _ => None,
                })
                .collect()
        }
    }

    impl TransferHooks for Hooks {
        fn emit(&self, event: TransferEvent) {
            if let (Some((limit, token)), TransferEvent::Progress { bytes_done, .. }) = (&self.cancel_on_progress, &event) {
                if bytes_done >= limit {
                    token.cancel();
                }
            }
            self.events.lock().unwrap().push(event);
        }

        fn resolve_conflict(&self, _info: ConflictInfo) -> BoxFuture<Resolution> {
            self.asked.fetch_add(1, Ordering::SeqCst);
            let answer = self.answers.lock().unwrap().pop_front();
            Box::pin(async move {
                answer.unwrap_or(Resolution { decision: ConflictDecision::Skip, apply_to_all: false })
            })
        }
    }

    fn path(dir: &Path, rel: &str) -> String {
        let base = dir.to_string_lossy().replace('\\', "/");
        if rel.is_empty() { base } else { format!("{base}/{rel}") }
    }
    use std::path::Path;

    fn job(src: Fs, dst: Fs, sources: Vec<String>, dst_dir: &str, policy: ConflictPolicy) -> TransferJob {
        let mut job = TransferJob::new(src, dst, sources, dst_dir.to_string());
        job.conflict = policy;
        job
    }

    fn fixture_tree(root: &Path) {
        fs::create_dir_all(root.join("proj/sub/deeper")).unwrap();
        fs::write(root.join("proj/a.txt"), b"alpha").unwrap();
        fs::write(root.join("proj/sub/b.bin"), vec![7u8; 700_000]).unwrap();
        fs::write(root.join("proj/sub/deeper/c.txt"), b"gamma").unwrap();
        fs::write(root.join("loose.txt"), b"loose").unwrap();
    }

    async fn connect_remote(server: &TestServer, dir: &Path) -> (Fs, Arc<crate::session::SshSession>) {
        let ctx = context(dir);
        trust(&ctx, server);
        let session = SshSession::connect(&ctx, &password_spec(server, "alice", "secret"), None).await.unwrap();
        let sftp = session.open_sftp().await.unwrap();
        (Fs::Remote(Arc::new(sftp)), session)
    }

    fn alice() -> Opts {
        Opts { users: vec![("alice".to_string(), "secret".to_string())], ..Default::default() }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn copies_a_tree_between_local_folders_and_reports_monotonic_progress() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        fixture_tree(src.path());
        let hooks = Hooks::new();
        let summary = run(
            job(Fs::Local, Fs::Local, vec![path(src.path(), "proj"), path(src.path(), "loose.txt")], &path(dst.path(), ""), ConflictPolicy::Skip),
            hooks.clone(),
            CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(summary.files_done, 4);
        assert_eq!(summary.bytes_done, 5 + 700_000 + 5 + 5);
        assert!(summary.errors.is_empty() && !summary.cancelled);
        assert_eq!(fs::read(dst.path().join("proj/sub/b.bin")).unwrap().len(), 700_000);
        assert_eq!(fs::read(dst.path().join("proj/sub/deeper/c.txt")).unwrap(), b"gamma");
        assert_eq!(fs::read(dst.path().join("loose.txt")).unwrap(), b"loose");
        let leftovers: Vec<_> = walk(dst.path()).into_iter().filter(|p| p.ends_with(".terax-part")).collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");

        let progress = hooks.progress_bytes();
        assert!(progress.windows(2).all(|w| w[0] <= w[1]));
        assert_eq!(*progress.last().unwrap(), summary.bytes_done);
        assert!(matches!(hooks.events.lock().unwrap()[0], TransferEvent::Planned { files: 4, .. }));
    }

    fn walk(root: &Path) -> Vec<String> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(dir).unwrap() {
                let entry = entry.unwrap();
                out.push(entry.path().to_string_lossy().into_owned());
                if entry.path().is_dir() {
                    stack.push(entry.path());
                }
            }
        }
        out
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn uploads_downloads_and_relays_between_two_servers() {
        let server_a = TestServer::start(alice()).await;
        let server_b = TestServer::start(alice()).await;
        let keep = tempfile::tempdir().unwrap();
        let (remote_a, _sa) = connect_remote(&server_a, keep.path()).await;
        let (remote_b, _sb) = connect_remote(&server_b, keep.path()).await;
        let local = tempfile::tempdir().unwrap();
        fixture_tree(local.path());

        let up = run(
            job(Fs::Local, remote_a.clone(), vec![path(local.path(), "proj")], "/", ConflictPolicy::Skip),
            Hooks::new(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(up.files_done, 3, "{:?}", up.errors);
        assert_eq!(fs::read(server_a.root.path().join("proj/sub/b.bin")).unwrap().len(), 700_000);

        let relay = run(
            job(remote_a.clone(), remote_b.clone(), vec!["/proj".to_string()], "/", ConflictPolicy::Skip),
            Hooks::new(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(relay.files_done, 3, "{:?}", relay.errors);
        assert_eq!(fs::read(server_b.root.path().join("proj/sub/deeper/c.txt")).unwrap(), b"gamma");

        let down_dir = tempfile::tempdir().unwrap();
        let down = run(
            job(remote_b.clone(), Fs::Local, vec!["/proj".to_string()], &path(down_dir.path(), ""), ConflictPolicy::Skip),
            Hooks::new(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(down.files_done, 3, "{:?}", down.errors);
        assert_eq!(fs::read(down_dir.path().join("proj/a.txt")).unwrap(), b"alpha");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn modification_times_and_executable_bits_survive_a_transfer() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let file = src.path().join("run.sh");
        fs::write(&file, b"#!/bin/sh\n").unwrap();
        let when = std::time::UNIX_EPOCH + Duration::from_secs(1_600_000_000);
        fs::OpenOptions::new().write(true).open(&file).unwrap().set_modified(when).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
        }
        run(
            job(Fs::Local, Fs::Local, vec![path(src.path(), "run.sh")], &path(dst.path(), ""), ConflictPolicy::Skip),
            Hooks::new(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let meta = fs::metadata(dst.path().join("run.sh")).unwrap();
        assert_eq!(meta.modified().unwrap(), when);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(meta.permissions().mode() & 0o777, 0o755);
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn conflict_policies_overwrite_skip_rename_and_update() {
        for (policy, expected_target, expected_copy) in [
            (ConflictPolicy::Overwrite, "new-content", None),
            (ConflictPolicy::Skip, "old", None),
            (ConflictPolicy::Rename, "old", Some("new-content")),
        ] {
            let src = tempfile::tempdir().unwrap();
            let dst = tempfile::tempdir().unwrap();
            fs::write(src.path().join("f.txt"), b"new-content").unwrap();
            fs::write(dst.path().join("f.txt"), b"old").unwrap();
            let summary = run(
                job(Fs::Local, Fs::Local, vec![path(src.path(), "f.txt")], &path(dst.path(), ""), policy),
                Hooks::new(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
            assert_eq!(fs::read_to_string(dst.path().join("f.txt")).unwrap(), expected_target, "{policy:?}");
            match expected_copy {
                Some(content) => {
                    assert_eq!(fs::read_to_string(dst.path().join("f (1).txt")).unwrap(), content);
                    assert_eq!(summary.files_done, 1);
                }
                None => assert!(!dst.path().join("f (1).txt").exists()),
            }
        }

        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        fs::write(src.path().join("same.txt"), b"1234").unwrap();
        fs::write(dst.path().join("same.txt"), b"abcd").unwrap();
        let old = std::time::UNIX_EPOCH + Duration::from_secs(1_000_000_000);
        fs::OpenOptions::new().write(true).open(src.path().join("same.txt")).unwrap().set_modified(old).unwrap();
        fs::OpenOptions::new().write(true).open(dst.path().join("same.txt")).unwrap().set_modified(old).unwrap();
        let summary = run(
            job(Fs::Local, Fs::Local, vec![path(src.path(), "same.txt")], &path(dst.path(), ""), ConflictPolicy::Update),
            Hooks::new(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(fs::read(dst.path().join("same.txt")).unwrap(), b"abcd", "identical size and time: kept");
        assert_eq!(summary.files_skipped, 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn asking_is_serialized_and_apply_to_all_sticks() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        for name in ["a.txt", "b.txt", "c.txt"] {
            fs::write(src.path().join(name), b"new").unwrap();
            fs::write(dst.path().join(name), b"old").unwrap();
        }
        let hooks = Hooks::answering(vec![Resolution { decision: ConflictDecision::Overwrite, apply_to_all: true }]);
        let sources = ["a.txt", "b.txt", "c.txt"].iter().map(|n| path(src.path(), n)).collect();
        let summary = run(
            job(Fs::Local, Fs::Local, sources, &path(dst.path(), ""), ConflictPolicy::Ask),
            hooks.clone(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(hooks.asked.load(Ordering::SeqCst), 1);
        assert_eq!(summary.files_done, 3);
        for name in ["a.txt", "b.txt", "c.txt"] {
            assert_eq!(fs::read(dst.path().join(name)).unwrap(), b"new");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn answering_cancel_stops_the_whole_job() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        fs::write(src.path().join("a.txt"), b"new").unwrap();
        fs::write(dst.path().join("a.txt"), b"old").unwrap();
        let hooks = Hooks::answering(vec![Resolution { decision: ConflictDecision::Cancel, apply_to_all: false }]);
        let summary = run(
            job(Fs::Local, Fs::Local, vec![path(src.path(), "a.txt")], &path(dst.path(), ""), ConflictPolicy::Ask),
            hooks,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert!(summary.cancelled);
        assert_eq!(fs::read(dst.path().join("a.txt")).unwrap(), b"old");
    }

    fn patterned(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cancelling_mid_file_leaves_no_final_file_and_no_part_file() {
        let server = TestServer::start(alice()).await;
        let keep = tempfile::tempdir().unwrap();
        let (remote, _session) = connect_remote(&server, keep.path()).await;
        let src = tempfile::tempdir().unwrap();
        fs::write(src.path().join("big.bin"), patterned(40 * 1024 * 1024)).unwrap();
        let cancel = CancellationToken::new();
        let hooks = Hooks::cancelling(1, cancel.clone());
        let mut j = job(Fs::Local, remote, vec![path(src.path(), "big.bin")], "/", ConflictPolicy::Skip);
        j.resume = false;
        let summary = run(j, hooks, cancel).await.unwrap();
        assert!(summary.cancelled);
        assert_eq!(summary.files_done, 0);
        assert!(!server.root.path().join("big.bin").exists());
        assert!(!server.root.path().join("big.bin.terax-part").exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_cancelled_transfer_can_be_resumed_to_a_byte_identical_file() {
        let server = TestServer::start(alice()).await;
        let keep = tempfile::tempdir().unwrap();
        let (remote, _session) = connect_remote(&server, keep.path()).await;
        let src = tempfile::tempdir().unwrap();
        let content = patterned(40 * 1024 * 1024);
        fs::write(src.path().join("big.bin"), &content).unwrap();

        let cancel = CancellationToken::new();
        let first = run(
            job(Fs::Local, remote.clone(), vec![path(src.path(), "big.bin")], "/", ConflictPolicy::Skip),
            Hooks::cancelling(1, cancel.clone()),
            cancel,
        )
        .await
        .unwrap();
        assert!(first.cancelled);
        assert!(!server.root.path().join("big.bin").exists());
        let part = server.root.path().join("big.bin.terax-part");
        let kept = fs::metadata(&part).expect("the part file is kept for resume").len();
        assert!(kept < content.len() as u64);

        let second = run(
            job(Fs::Local, remote, vec![path(src.path(), "big.bin")], "/", ConflictPolicy::Skip),
            Hooks::new(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(second.files_done, 1, "{:?}", second.errors);
        assert_eq!(fs::read(server.root.path().join("big.bin")).unwrap(), content);
        assert!(!part.exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_interrupted_copy_resumes_from_its_part_file() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let content: Vec<u8> = (0..1_000_000u32).map(|i| (i % 251) as u8).collect();
        fs::write(src.path().join("data.bin"), &content).unwrap();
        fs::write(dst.path().join("data.bin.terax-part"), &content[..400_000]).unwrap();
        let hooks = Hooks::new();
        let summary = run(
            job(Fs::Local, Fs::Local, vec![path(src.path(), "data.bin")], &path(dst.path(), ""), ConflictPolicy::Skip),
            hooks.clone(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(summary.files_done, 1, "{:?}", summary.errors);
        assert_eq!(fs::read(dst.path().join("data.bin")).unwrap(), content);
        assert!(!dst.path().join("data.bin.terax-part").exists());
        assert_eq!(summary.bytes_done, 1_000_000, "resumed bytes count as done");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_part_file_larger_than_the_source_is_discarded_not_resumed() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        fs::write(src.path().join("data.bin"), b"short").unwrap();
        fs::write(dst.path().join("data.bin.terax-part"), b"this is much longer than the source").unwrap();
        let summary = run(
            job(Fs::Local, Fs::Local, vec![path(src.path(), "data.bin")], &path(dst.path(), ""), ConflictPolicy::Skip),
            Hooks::new(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(summary.files_done, 1);
        assert_eq!(fs::read(dst.path().join("data.bin")).unwrap(), b"short");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn one_failing_item_does_not_stop_the_others() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        fs::create_dir(src.path().join("blocked")).unwrap();
        fs::write(src.path().join("blocked/inner.txt"), b"x").unwrap();
        fs::write(src.path().join("fine.txt"), b"fine").unwrap();
        fs::write(dst.path().join("blocked"), b"a file squats on the folder name").unwrap();
        let summary = run(
            job(Fs::Local, Fs::Local, vec![path(src.path(), "blocked"), path(src.path(), "fine.txt")], &path(dst.path(), ""), ConflictPolicy::Skip),
            Hooks::new(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(summary.files_done, 1);
        assert_eq!(summary.errors.len(), 1);
        assert!(summary.errors[0].path.ends_with("blocked"));
        assert_eq!(fs::read(dst.path().join("fine.txt")).unwrap(), b"fine");
        assert_eq!(fs::read(dst.path().join("blocked")).unwrap(), b"a file squats on the folder name");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn moving_within_one_endpoint_renames() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("from/sub")).unwrap();
        fs::write(root.path().join("from/sub/f.txt"), b"x").unwrap();
        fs::create_dir(root.path().join("to")).unwrap();
        let mut j = job(Fs::Local, Fs::Local, vec![path(root.path(), "from/sub")], &path(root.path(), "to"), ConflictPolicy::Skip);
        j.mode = TransferMode::Move;
        let summary = run(j, Hooks::new(), CancellationToken::new()).await.unwrap();
        assert_eq!(summary.moved, 1);
        assert!(root.path().join("to/sub/f.txt").exists());
        assert!(!root.path().join("from/sub").exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn moving_into_itself_is_an_error_not_a_loop() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("a/b")).unwrap();
        let mut j = job(Fs::Local, Fs::Local, vec![path(root.path(), "a")], &path(root.path(), "a/b"), ConflictPolicy::Skip);
        j.mode = TransferMode::Move;
        let summary = run(j, Hooks::new(), CancellationToken::new()).await.unwrap();
        assert_eq!(summary.errors.len(), 1);
        assert!(root.path().join("a/b").exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn moving_across_endpoints_copies_then_deletes_the_source() {
        let server = TestServer::start(alice()).await;
        let keep = tempfile::tempdir().unwrap();
        let (remote, _session) = connect_remote(&server, keep.path()).await;
        let local = tempfile::tempdir().unwrap();
        fixture_tree(local.path());
        let mut j = job(Fs::Local, remote, vec![path(local.path(), "proj")], "/", ConflictPolicy::Skip);
        j.mode = TransferMode::Move;
        let summary = run(j, Hooks::new(), CancellationToken::new()).await.unwrap();
        assert_eq!(summary.files_done, 3, "{:?}", summary.errors);
        assert_eq!(summary.moved, 1);
        assert!(server.root.path().join("proj/sub/b.bin").exists());
        assert!(!local.path().join("proj").exists());
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_move_keeps_the_source_when_something_inside_was_not_copied() {
        let server = TestServer::start(alice()).await;
        let keep = tempfile::tempdir().unwrap();
        let (remote, _session) = connect_remote(&server, keep.path()).await;
        let src = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        fs::create_dir(src.path().join("proj")).unwrap();
        fs::write(src.path().join("proj/a.txt"), b"a").unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), src.path().join("proj/link")).unwrap();
        fs::write(src.path().join("clean.txt"), b"c").unwrap();
        let mut j = job(
            Fs::Local,
            remote,
            vec![path(src.path(), "proj"), path(src.path(), "clean.txt")],
            "/",
            ConflictPolicy::Skip,
        );
        j.mode = TransferMode::Move;
        let summary = run(j, Hooks::new(), CancellationToken::new()).await.unwrap();
        assert_eq!(summary.skipped.len(), 1);
        assert!(server.root.path().join("proj/a.txt").exists());
        assert!(src.path().join("proj/a.txt").exists(), "the folder holding a skipped link stays");
        assert!(src.path().join("proj/link").exists());
        assert!(!src.path().join("clean.txt").exists(), "fully copied items are removed");
        assert_eq!(summary.moved, 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_skipped_conflict_keeps_the_source_of_a_move() {
        let server = TestServer::start(alice()).await;
        let keep = tempfile::tempdir().unwrap();
        let (remote, _session) = connect_remote(&server, keep.path()).await;
        let src = tempfile::tempdir().unwrap();
        fs::write(src.path().join("f.txt"), b"new").unwrap();
        fs::write(server.root.path().join("f.txt"), b"old").unwrap();
        let mut j = job(Fs::Local, remote, vec![path(src.path(), "f.txt")], "/", ConflictPolicy::Skip);
        j.mode = TransferMode::Move;
        let summary = run(j, Hooks::new(), CancellationToken::new()).await.unwrap();
        assert_eq!(summary.files_skipped, 1);
        assert!(src.path().join("f.txt").exists());
        assert_eq!(fs::read(server.root.path().join("f.txt")).unwrap(), b"old");
    }
}
