//! The wire format between the extension host and the helper.
//!
//! Every message is one frame: `[len: u32 LE][kind: u8][session: u32 LE][payload]`, where `len`
//! counts everything after the length field (`5 + payload.len()`).

use std::io::{self, Read, Write};

/// Largest frame accepted. A shell's output arrives in far smaller pieces; this only bounds what a
/// confused or hostile peer can make the helper allocate.
pub const MAX_FRAME: usize = 2 * 1024 * 1024;

const HEADER: usize = 5;

// Host to helper.
pub const SPAWN: u8 = 1;
pub const WRITE: u8 = 2;
pub const RESIZE: u8 = 3;
pub const KILL: u8 = 4;
pub const PAUSE: u8 = 5;
pub const RESUME: u8 = 6;

// Helper to host.
pub const READY: u8 = 0x80;
pub const SPAWNED: u8 = 0x81;
pub const DATA: u8 = 0x82;
pub const EXIT: u8 = 0x83;
pub const ERROR: u8 = 0x84;

#[derive(Debug, PartialEq, Eq)]
pub struct Frame {
    pub kind: u8,
    pub session: u32,
    pub payload: Vec<u8>,
}

/// Reads one frame. `Ok(None)` means the peer closed the stream between frames.
pub fn read_frame<R: Read>(reader: &mut R) -> io::Result<Option<Frame>> {
    let mut len_bytes = [0u8; 4];
    loop {
        match reader.read(&mut len_bytes[..1]) {
            Ok(0) => return Ok(None),
            Ok(_) => break,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    reader.read_exact(&mut len_bytes[1..])?;
    let len = u32::from_le_bytes(len_bytes) as usize;
    if !(HEADER..=MAX_FRAME).contains(&len) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame length {len} is outside {HEADER}..={MAX_FRAME}"),
        ));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    let kind = body[0];
    let session = u32::from_le_bytes([body[1], body[2], body[3], body[4]]);
    body.drain(..HEADER);
    Ok(Some(Frame {
        kind,
        session,
        payload: body,
    }))
}

pub fn encode_frame(kind: u8, session: u32, payload: &[u8]) -> Vec<u8> {
    let len = (HEADER + payload.len()) as u32;
    let mut out = Vec::with_capacity(4 + HEADER + payload.len());
    out.extend_from_slice(&len.to_le_bytes());
    out.push(kind);
    out.extend_from_slice(&session.to_le_bytes());
    out.extend_from_slice(payload);
    out
}

pub fn write_frame<W: Write>(
    writer: &mut W,
    kind: u8,
    session: u32,
    payload: &[u8],
) -> io::Result<()> {
    writer.write_all(&encode_frame(kind, session, payload))?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn a_frame_survives_a_round_trip() {
        let bytes = encode_frame(DATA, 7, b"hello\x1b[0m");
        let frame = read_frame(&mut Cursor::new(bytes)).unwrap().unwrap();
        assert_eq!(
            frame,
            Frame {
                kind: DATA,
                session: 7,
                payload: b"hello\x1b[0m".to_vec()
            }
        );
    }

    #[test]
    fn an_empty_payload_is_allowed() {
        let bytes = encode_frame(KILL, 1, &[]);
        let frame = read_frame(&mut Cursor::new(bytes)).unwrap().unwrap();
        assert_eq!(frame.kind, KILL);
        assert!(frame.payload.is_empty());
    }

    #[test]
    fn frames_follow_each_other_and_the_end_is_clean() {
        let mut bytes = encode_frame(WRITE, 1, b"a");
        bytes.extend(encode_frame(WRITE, 2, b"bc"));
        let mut cursor = Cursor::new(bytes);
        assert_eq!(read_frame(&mut cursor).unwrap().unwrap().payload, b"a");
        assert_eq!(read_frame(&mut cursor).unwrap().unwrap().session, 2);
        assert_eq!(read_frame(&mut cursor).unwrap(), None);
    }

    #[test]
    fn a_truncated_frame_is_an_error_not_a_clean_end() {
        let mut bytes = encode_frame(DATA, 1, b"abcdef");
        bytes.truncate(bytes.len() - 2);
        assert!(read_frame(&mut Cursor::new(bytes)).is_err());
    }

    #[test]
    fn lengths_outside_the_allowed_range_are_rejected_without_allocating() {
        let too_big = ((MAX_FRAME + 1) as u32).to_le_bytes().to_vec();
        assert!(read_frame(&mut Cursor::new(too_big)).is_err());
        let too_small = 2u32.to_le_bytes().to_vec();
        assert!(read_frame(&mut Cursor::new(too_small)).is_err());
    }

    #[test]
    fn nothing_at_all_is_a_clean_end_but_half_a_length_prefix_is_not() {
        assert_eq!(read_frame(&mut Cursor::new(Vec::new())).unwrap(), None);
        assert!(read_frame(&mut Cursor::new(vec![9u8, 0])).is_err());
    }
}
