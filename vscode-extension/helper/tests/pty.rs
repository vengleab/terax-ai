//! Runs the built helper against real pseudo-terminals, speaking the same frames the extension does.

#![cfg(unix)]

use std::io::Write;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

const SPAWN: u8 = 1;
const WRITE: u8 = 2;
const RESIZE: u8 = 3;
const KILL: u8 = 4;
const PAUSE: u8 = 5;
const RESUME: u8 = 6;
const READY: u8 = 0x80;
const SPAWNED: u8 = 0x81;
const DATA: u8 = 0x82;
const EXIT: u8 = 0x83;
const ERROR: u8 = 0x84;

#[derive(Debug)]
struct Message {
    kind: u8,
    session: u32,
    payload: Vec<u8>,
}

struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    messages: Receiver<Message>,
}

fn encode(kind: u8, session: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = ((5 + payload.len()) as u32).to_le_bytes().to_vec();
    out.push(kind);
    out.extend(session.to_le_bytes());
    out.extend(payload);
    out
}

impl Helper {
    fn start() -> Helper {
        let mut child = Command::new(env!("CARGO_BIN_EXE_terax-vscode-pty"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start helper");
        let stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            use std::io::Read;
            loop {
                let mut len = [0u8; 4];
                if stdout.read_exact(&mut len).is_err() {
                    return;
                }
                let mut body = vec![0u8; u32::from_le_bytes(len) as usize];
                if stdout.read_exact(&mut body).is_err() {
                    return;
                }
                let session = u32::from_le_bytes([body[1], body[2], body[3], body[4]]);
                let message = Message {
                    kind: body[0],
                    session,
                    payload: body[5..].to_vec(),
                };
                if tx.send(message).is_err() {
                    return;
                }
            }
        });
        let helper = Helper {
            child,
            stdin: Some(stdin),
            messages: rx,
        };
        let ready = helper.next(Duration::from_secs(5)).expect("ready frame");
        assert_eq!(ready.kind, READY);
        assert!(String::from_utf8_lossy(&ready.payload).contains("\"version\":1"));
        helper
    }

    fn send(&mut self, kind: u8, session: u32, payload: &[u8]) {
        let stdin = self.stdin.as_mut().expect("stdin still open");
        stdin.write_all(&encode(kind, session, payload)).unwrap();
        stdin.flush().unwrap();
    }

    /// What the helper sees when the extension host goes away.
    fn close_stdin(&mut self) {
        self.stdin = None;
    }

    fn spawn_shell(&mut self, session: u32, script: &str, cols: u16, rows: u16) {
        let request = format!(
            "{{\"file\":\"/bin/sh\",\"args\":[\"-c\",{}],\"cols\":{cols},\"rows\":{rows}}}",
            serde_json_string(script)
        );
        self.send(SPAWN, session, request.as_bytes());
    }

    fn next(&self, timeout: Duration) -> Option<Message> {
        match self.messages.recv_timeout(timeout) {
            Ok(m) => Some(m),
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => None,
        }
    }

    /// Collects output for `session` until `done` is satisfied by what has arrived, or fails the test.
    fn read_until(&self, session: u32, what: &str, done: impl Fn(&str, Option<i32>) -> bool) -> (String, Option<i32>) {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut text = Vec::new();
        let mut exit = None;
        while Instant::now() < deadline {
            let Some(m) = self.next(Duration::from_millis(200)) else {
                continue;
            };
            if m.session != session {
                continue;
            }
            match m.kind {
                DATA => text.extend(m.payload),
                EXIT => exit = Some(i32::from_le_bytes(m.payload[..4].try_into().unwrap())),
                ERROR => panic!("helper error: {}", String::from_utf8_lossy(&m.payload)),
                _ => {}
            }
            let so_far = String::from_utf8_lossy(&text).into_owned();
            if done(&so_far, exit) {
                return (so_far, exit);
            }
        }
        panic!("timed out waiting for {what}; got {:?}", String::from_utf8_lossy(&text));
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn serde_json_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[test]
fn runs_a_command_and_reports_its_output_and_exit_code() {
    let mut helper = Helper::start();
    helper.spawn_shell(1, "printf 'hello from the pty'; exit 3", 80, 24);
    let spawned = helper.next(Duration::from_secs(5)).expect("spawned");
    assert_eq!(spawned.kind, SPAWNED);
    assert!(u32::from_le_bytes(spawned.payload[..4].try_into().unwrap()) > 0);
    let (text, exit) = helper.read_until(1, "exit", |_, exit| exit.is_some());
    assert!(text.contains("hello from the pty"), "{text:?}");
    assert_eq!(exit, Some(3));
}

#[test]
fn input_reaches_the_shell_and_is_echoed_like_a_terminal() {
    let mut helper = Helper::start();
    helper.spawn_shell(1, "cat", 80, 24);
    helper.send(WRITE, 1, b"typed text\n");
    let (text, _) = helper.read_until(1, "echo", |t, _| t.matches("typed text").count() >= 2);
    assert!(text.contains("typed text"));
    helper.send(WRITE, 1, &[4]); // Ctrl-D ends cat
    let (_, exit) = helper.read_until(1, "exit", |_, exit| exit.is_some());
    assert_eq!(exit, Some(0));
}

#[test]
fn the_terminal_size_is_set_at_start_and_follows_resizes() {
    let mut helper = Helper::start();
    helper.spawn_shell(1, "stty size; read x; stty size", 100, 30);
    let (text, _) = helper.read_until(1, "first size", |t, _| t.contains("30 100"));
    assert!(text.contains("30 100"));
    let mut size = 132u16.to_le_bytes().to_vec();
    size.extend(40u16.to_le_bytes());
    helper.send(RESIZE, 1, &size);
    helper.send(WRITE, 1, b"\n");
    let (text, _) = helper.read_until(1, "second size", |t, _| t.contains("40 132"));
    assert!(text.contains("40 132"));
}

#[test]
fn the_environment_names_a_color_terminal_in_utf8() {
    let mut helper = Helper::start();
    helper.spawn_shell(1, "printf '%s|%s' \"$TERM\" \"$COLORTERM\"", 80, 24);
    let (text, _) = helper.read_until(1, "env", |t, _| t.contains("xterm-256color|truecolor"));
    assert!(text.contains("xterm-256color|truecolor"));
}

#[test]
fn a_working_directory_and_extra_environment_are_applied() {
    let mut helper = Helper::start();
    let request = "{\"file\":\"/bin/sh\",\"args\":[\"-c\",\"pwd; printf %s \\\"$TERAX_TEST\\\"\"],\"cwd\":\"/tmp\",\"env\":{\"TERAX_TEST\":\"set-by-host\"},\"cols\":80,\"rows\":24}";
    helper.send(SPAWN, 1, request.as_bytes());
    let (text, _) = helper.read_until(1, "cwd and env", |t, _| t.contains("set-by-host"));
    assert!(text.contains("/tmp"), "{text:?}");
}

#[test]
fn kill_ends_a_session_that_ignores_hangup_politely() {
    let mut helper = Helper::start();
    helper.spawn_shell(1, "trap '' HUP INT TERM; echo ready; while true; do sleep 1; done", 80, 24);
    helper.read_until(1, "ready", |t, _| t.contains("ready"));
    helper.send(KILL, 1, &[]);
    let (_, exit) = helper.read_until(1, "exit after kill", |_, exit| exit.is_some());
    assert!(exit.is_some());
}

#[test]
fn sessions_are_independent() {
    let mut helper = Helper::start();
    helper.spawn_shell(1, "sleep 0.3; echo one; exit 1", 80, 24);
    helper.spawn_shell(2, "echo two; exit 2", 80, 24);
    let (two, exit_two) = helper.read_until(2, "session two", |_, exit| exit.is_some());
    assert!(two.contains("two") && !two.contains("one"));
    assert_eq!(exit_two, Some(2));
    let (one, exit_one) = helper.read_until(1, "session one", |_, exit| exit.is_some());
    assert!(one.contains("one") && !one.contains("two"));
    assert_eq!(exit_one, Some(1));
}

#[test]
fn pausing_stops_output_and_resuming_brings_it_back() {
    let mut helper = Helper::start();
    helper.spawn_shell(1, "yes terax-flow-control", 80, 24);
    helper.read_until(1, "first output", |t, _| t.contains("terax-flow-control"));
    helper.send(PAUSE, 1, &[]);
    // Whatever was already in flight may still arrive; after that it must go quiet.
    while helper.next(Duration::from_millis(400)).is_some() {}
    assert!(helper.next(Duration::from_millis(600)).is_none(), "output kept flowing while paused");
    helper.send(RESUME, 1, &[]);
    let m = helper.next(Duration::from_secs(5)).expect("output after resume");
    assert_eq!(m.kind, DATA);
    helper.send(KILL, 1, &[]);
}

#[test]
fn a_program_that_does_not_exist_is_an_error_for_that_session_only() {
    let mut helper = Helper::start();
    let request = "{\"file\":\"/definitely/not/a/shell\",\"cols\":80,\"rows\":24}";
    helper.send(SPAWN, 9, request.as_bytes());
    let m = helper.next(Duration::from_secs(5)).expect("error");
    assert_eq!((m.kind, m.session), (ERROR, 9));
    assert!(String::from_utf8_lossy(&m.payload).contains("/definitely/not/a/shell"));
    helper.spawn_shell(1, "echo still alive", 80, 24);
    helper.read_until(1, "next session works", |t, _| t.contains("still alive"));
}

#[test]
fn bad_requests_are_reported_and_do_not_end_the_helper() {
    let mut helper = Helper::start();
    helper.send(SPAWN, 1, b"not json");
    let m = helper.next(Duration::from_secs(5)).expect("error");
    assert_eq!(m.kind, ERROR);
    helper.send(RESIZE, 1, b"xx");
    helper.send(99, 1, &[]);
    helper.spawn_shell(2, "echo fine", 80, 24);
    helper.read_until(2, "still serving", |t, _| t.contains("fine"));
}

#[test]
fn a_session_id_cannot_be_reused_while_it_is_running() {
    let mut helper = Helper::start();
    helper.spawn_shell(1, "sleep 30", 80, 24);
    assert_eq!(helper.next(Duration::from_secs(5)).unwrap().kind, SPAWNED);
    helper.spawn_shell(1, "echo nope", 80, 24);
    let m = helper.next(Duration::from_secs(5)).expect("error");
    assert_eq!(m.kind, ERROR);
    helper.send(KILL, 1, &[]);
}

fn process_alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[test]
fn shells_are_taken_down_when_the_extension_host_goes_away() {
    let mut helper = Helper::start();
    helper.spawn_shell(1, "trap '' HUP; echo started; while true; do sleep 1; done", 80, 24);
    let spawned = helper.next(Duration::from_secs(5)).expect("spawned");
    assert_eq!(spawned.kind, SPAWNED);
    let shell_pid = u32::from_le_bytes(spawned.payload[..4].try_into().unwrap());
    helper.read_until(1, "started", |t, _| t.contains("started"));
    assert!(process_alive(shell_pid));

    helper.close_stdin();
    let deadline = Instant::now() + Duration::from_secs(8);
    while helper.child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "helper did not exit after stdin closed");
        thread::sleep(Duration::from_millis(50));
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while process_alive(shell_pid) {
        assert!(Instant::now() < deadline, "the shell outlived the helper");
        thread::sleep(Duration::from_millis(50));
    }
}
