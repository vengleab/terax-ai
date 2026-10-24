//! Terax terminal helper for VS Code.
//!
//! The extension host talks to this process over stdin and stdout with the frames in `frame.rs`.
//! It owns the pseudo-terminals, so the extension does not need a native Node module.

mod frame;
mod output;
mod session;

use std::collections::HashMap;
use std::io::{self, BufReader};
use std::sync::{Arc, Mutex};

use output::Output;
use session::{Sessions, SpawnRequest};

const PROTOCOL_VERSION: u32 = 1;

fn lock(sessions: &Sessions) -> std::sync::MutexGuard<'_, HashMap<u32, session::Session>> {
    sessions.lock().unwrap_or_else(|e| e.into_inner())
}

fn read_u16_pair(payload: &[u8]) -> Option<(u16, u16)> {
    let bytes: [u8; 4] = payload.try_into().ok()?;
    Some((
        u16::from_le_bytes([bytes[0], bytes[1]]),
        u16::from_le_bytes([bytes[2], bytes[3]]),
    ))
}

fn handle(frame: frame::Frame, out: &Output, sessions: &Sessions) {
    let id = frame.session;
    match frame.kind {
        frame::SPAWN => {
            let request: SpawnRequest = match serde_json::from_slice(&frame.payload) {
                Ok(request) => request,
                Err(e) => return out.error(id, &format!("bad spawn request: {e}")),
            };
            if lock(sessions).contains_key(&id) {
                return out.error(id, "session id already in use");
            }
            match session::spawn(id, request, out.clone(), sessions.clone()) {
                Ok(pid) => {
                    let _ = out.send(frame::SPAWNED, id, &pid.to_le_bytes());
                }
                Err(message) => out.error(id, &message),
            }
        }
        frame::WRITE => {
            if let Some(session) = lock(sessions).get(&id) {
                session.write(frame.payload);
            }
        }
        frame::RESIZE => {
            let Some((cols, rows)) = read_u16_pair(&frame.payload) else {
                return out.error(id, "resize needs 4 bytes");
            };
            if let Some(session) = lock(sessions).get(&id) {
                if let Err(message) = session.resize(cols, rows) {
                    out.error(id, &message);
                }
            }
        }
        frame::KILL => {
            if let Some(session) = lock(sessions).get_mut(&id) {
                session.kill();
            }
        }
        frame::PAUSE | frame::RESUME => {
            if let Some(session) = lock(sessions).get(&id) {
                session.set_paused(frame.kind == frame::PAUSE);
            }
        }
        other => out.error(id, &format!("unknown frame type {other}")),
    }
}

fn main() {
    let out = Output::new(Box::new(io::stdout()));
    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
    let hello = format!("{{\"version\":{PROTOCOL_VERSION},\"pid\":{}}}", std::process::id());
    if out.send(frame::READY, 0, hello.as_bytes()).is_err() {
        return;
    }

    let mut input = BufReader::new(io::stdin().lock());
    // Ends when the extension host goes away (or sends garbage): every shell is taken down with it.
    while let Ok(Some(frame)) = frame::read_frame(&mut input) {
        handle(frame, &out, &sessions);
    }
    shutdown(&sessions);
}

/// Hangs up every shell and waits (a little longer than the kill grace) for them to be gone, so the
/// escalation to a hard kill gets to run before this process exits.
fn shutdown(sessions: &Sessions) {
    for session in lock(sessions).values_mut() {
        session.kill();
    }
    let deadline = std::time::Instant::now() + session::Session::grace() + std::time::Duration::from_millis(1500);
    while !lock(sessions).is_empty() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}
