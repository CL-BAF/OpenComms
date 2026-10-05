//! Bounded, correlated stdio framing. This module has no Tauri dependency.
use std::io::{BufRead, BufReader};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::time::Duration;

// Four UTF-8 bytes per JavaScript character accommodates the sidecar's
// 1,000,000 character limit without allowing an unbounded native allocation.
pub const MAX_LINE_BYTES: usize = 4_000_000;

pub struct WriteRequest {
    line: String,
    result: SyncSender<Result<(), String>>,
}

pub fn request_writer<W: std::io::Write + Send + 'static>(mut source: W) -> SyncSender<WriteRequest> {
    let (sender, receiver) = sync_channel::<WriteRequest>(1);
    std::thread::spawn(move || {
        for request in receiver {
            let result = source.write_all(request.line.as_bytes())
                .and_then(|_| source.flush())
                .map_err(|_| "coordinator write failed".to_string());
            let failed = result.is_err();
            let _ = request.result.send(result);
            if failed { break; }
        }
    });
    sender
}

pub fn write_frame(sender: &SyncSender<WriteRequest>, line: String, timeout: Duration) -> Result<(), String> {
    let (result, receiver) = sync_channel(1);
    sender.try_send(WriteRequest { line, result })
        .map_err(|_| "coordinator write queue is unavailable".to_string())?;
    receiver.recv_timeout(timeout)
        .map_err(|_| "coordinator write timed out".to_string())?
}

pub fn read_line_bounded<R: BufRead>(reader: &mut R, limit: usize) -> Result<String, String> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(|_| "bridge read failed".to_string())?;
        if available.is_empty() {
            return Err("coordinator closed the bridge before a complete response".into());
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(available.len(), |index| index + 1);
        if line.len().saturating_add(count) > limit {
            return Err("bridge response exceeds the allowed size".into());
        }
        line.extend_from_slice(&available[..count]);
        reader.consume(count);
        if newline.is_some() {
            return String::from_utf8(line).map_err(|_| "bridge response is not UTF-8".into());
        }
    }
}

pub fn response_reader<R: std::io::Read + Send + 'static>(source: R) -> Receiver<Result<String, String>> {
    // One buffered response bounds unsolicited output; receiver drop ends the worker after child exit.
    let (sender, receiver) = sync_channel(1);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(source);
        loop {
            let line = read_line_bounded(&mut reader, MAX_LINE_BYTES);
            let failed = line.is_err();
            if sender.send(line).is_err() || failed {
                break;
            }
        }
    });
    receiver
}

pub fn validate_response(raw: &str, request_id: &str) -> Result<serde_json::Value, String> {
    let response: serde_json::Value = serde_json::from_str(raw.trim())
        .map_err(|_| "bridge response is not valid JSON".to_string())?;
    if response.get("id").and_then(|id| id.as_str()) != Some(request_id) {
        return Err("bridge response request identifier mismatch".into());
    }
    if response.get("ok").and_then(|ok| ok.as_bool()).is_none() {
        return Err("bridge response lacks a boolean result".into());
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn bounded_reader_accepts_complete_frames_and_retains_next_frame() {
        let mut reader = Cursor::new(b"one\ntwo\n");
        assert_eq!(read_line_bounded(&mut reader, 4).unwrap(), "one\n");
        assert_eq!(read_line_bounded(&mut reader, 4).unwrap(), "two\n");
    }

    #[test]
    fn bounded_reader_rejects_oversized_or_partial_frames() {
        assert!(read_line_bounded(&mut Cursor::new(b"12345\n"), 5).is_err());
        assert!(read_line_bounded(&mut Cursor::new(b"partial"), 20).is_err());
    }

    #[test]
    fn response_must_belong_to_request_and_have_real_result() {
        assert!(validate_response(r#"{"id":"b","ok":true}"#, "a").is_err());
        assert!(validate_response(r#"{"id":"a","data":{}}"#, "a").is_err());
        assert!(validate_response(r#"{"id":"a","ok":false,"message":"denied"}"#, "a").is_ok());
    }

    #[test]
    fn blocked_writer_has_an_independent_deadline() {
        struct BlockedWriter(Receiver<()>);
        impl std::io::Write for BlockedWriter {
            fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
                let _ = self.0.recv();
                Ok(data.len())
            }
            fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
        }
        let (release, pending) = sync_channel(1);
        let writer = request_writer(BlockedWriter(pending));
        assert!(write_frame(&writer, "request\n".into(), Duration::from_millis(1)).is_err());
        release.send(()).unwrap();
        drop(writer);
    }
}
