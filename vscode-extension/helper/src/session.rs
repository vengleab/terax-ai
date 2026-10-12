//! One shell in one pseudo-terminal.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::{self, Sender};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;

use crate::frame;
use crate::output::Output;

/// How long to keep collecting output after the shell itself has exited, for a descendant that still
/// holds the terminal open.
const DRAIN_GRACE: Duration = Duration::from_millis(400);
const READ_CHUNK: usize = 16 * 1024;
/// How long a shell gets to act on the hangup before it is killed outright.
const KILL_GRACE: Duration = Duration::from_millis(1000);

#[derive(Debug, Deserialize)]
pub struct SpawnRequest {
    pub file: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

/// Lets the host stop the reader when the page cannot keep up, which in turn makes the shell block on
/// a full terminal buffer instead of the helper queuing output without limit.
#[derive(Default)]
struct Flow {
    paused: Mutex<bool>,
    changed: Condvar,
}

impl Flow {
    fn set(&self, paused: bool) {
        *lock(&self.paused) = paused;
        self.changed.notify_all();
    }

    fn wait_until_running(&self) {
        let mut paused = lock(&self.paused);
        while *paused {
            paused = self
                .changed
                .wait(paused)
                .unwrap_or_else(|e| e.into_inner());
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

pub struct Session {
    master: Box<dyn MasterPty + Send>,
    input: Sender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    flow: Arc<Flow>,
    // Only the Unix kill path needs these: it signals the process group once the grace period is up.
    #[cfg_attr(not(unix), allow(dead_code))]
    pid: u32,
    #[cfg_attr(not(unix), allow(dead_code))]
    exited: Arc<AtomicBool>,
}

pub type Sessions = Arc<Mutex<HashMap<u32, Session>>>;

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn is_utf8(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("utf-8") || lower.contains("utf8")
}

fn ensure_utf8_locale(cmd: &mut CommandBuilder, env: &HashMap<String, String>) {
    let utf8 = |key: &str| {
        env.get(key)
            .cloned()
            .or_else(|| std::env::var(key).ok())
            .is_some_and(|v| is_utf8(&v))
    };
    if ["LC_ALL", "LC_CTYPE", "LANG"].iter().any(|k| utf8(k)) {
        return;
    }
    #[cfg(target_os = "macos")]
    cmd.env("LANG", "en_US.UTF-8");
    #[cfg(not(target_os = "macos"))]
    cmd.env("LANG", "C.UTF-8");
}

/// Starts a shell, and the threads that move its input and output. Returns the shell's process id.
pub fn spawn(
    id: u32,
    request: SpawnRequest,
    out: Output,
    sessions: Sessions,
) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(size(request.cols, request.rows))
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&request.file);
    cmd.args(&request.args);
    if let Some(cwd) = request.cwd.as_deref().filter(|c| !c.is_empty()) {
        cmd.cwd(cwd);
    }
    for (key, value) in &request.env {
        cmd.env(key, value);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    ensure_utf8_locale(&mut cmd, &request.env);

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("could not start {}: {e}", request.file))?;
    // The child holds the slave end now; keeping ours open would stop EOF from ever arriving.
    drop(pair.slave);

    let pid = child.process_id().unwrap_or(0);
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let flow = Arc::new(Flow::default());
    let exited = Arc::new(AtomicBool::new(false));

    let (input, input_rx) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        // A separate thread, so a full terminal buffer blocks only this session's input.
        while let Ok(bytes) = input_rx.recv() {
            if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() {
                break;
            }
        }
    });

    let (reader_done, reader_done_rx) = mpsc::channel::<()>();
    {
        let out = out.clone();
        let flow = flow.clone();
        thread::spawn(move || {
            let mut buf = vec![0u8; READ_CHUNK];
            loop {
                flow.wait_until_running();
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if out.send(frame::DATA, id, &buf[..n]).is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = reader_done.send(());
        });
    }

    {
        let sessions = sessions.clone();
        let exited = exited.clone();
        thread::spawn(move || {
            let code = child
                .wait()
                .map(|status| status.exit_code() as i32)
                .unwrap_or(-1);
            exited.store(true, Ordering::SeqCst);
            let _ = reader_done_rx.recv_timeout(DRAIN_GRACE);
            lock(&sessions).remove(&id);
            let _ = out.send(frame::EXIT, id, &code.to_le_bytes());
        });
    }

    lock(&sessions).insert(
        id,
        Session {
            master: pair.master,
            input,
            killer,
            flow,
            pid,
            exited,
        },
    );
    Ok(pid)
}

impl Session {
    pub fn write(&self, bytes: Vec<u8>) {
        let _ = self.input.send(bytes);
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master.resize(size(cols, rows)).map_err(|e| e.to_string())
    }

    pub fn set_paused(&self, paused: bool) {
        self.flow.set(paused);
    }

    /// Asks the shell to hang up and, if it has not exited after a grace period, kills it and
    /// everything in its process group.
    pub fn kill(&mut self) {
        // A paused reader would never notice the end, so let it run.
        self.flow.set(false);
        let _ = self.killer.kill();
        #[cfg(unix)]
        {
            let (pid, exited) = (self.pid, self.exited.clone());
            thread::spawn(move || {
                thread::sleep(KILL_GRACE);
                // `exited` is set the moment the shell is reaped, so a recycled pid is not signalled.
                if !exited.load(Ordering::SeqCst) && pid > 1 {
                    unsafe {
                        libc::kill(-(pid as i32), libc::SIGKILL);
                        libc::kill(pid as i32, libc::SIGKILL);
                    }
                }
            });
        }
    }

    pub fn grace() -> Duration {
        KILL_GRACE
    }
}
