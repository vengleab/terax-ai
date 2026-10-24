use std::io::{self, Write};
use std::sync::{Arc, Mutex};

use crate::frame;

/// The helper's stdout, shared by every session's threads. A frame is written under one lock, so
/// frames from different sessions never interleave.
#[derive(Clone)]
pub struct Output {
    inner: Arc<Mutex<Box<dyn Write + Send>>>,
}

impl Output {
    pub fn new(writer: Box<dyn Write + Send>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(writer)),
        }
    }

    pub fn send(&self, kind: u8, session: u32, payload: &[u8]) -> io::Result<()> {
        let mut writer = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        frame::write_frame(&mut *writer, kind, session, payload)
    }

    pub fn error(&self, session: u32, message: &str) {
        let _ = self.send(frame::ERROR, session, message.as_bytes());
    }
}
