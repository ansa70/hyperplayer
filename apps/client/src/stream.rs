//! Progressive HTTP stream: a background thread downloads while a `Read + Seek`
//! handle hands bytes to the decoder as soon as they arrive.
//!
//! Memory stays bounded: the download pauses once it is `READ_AHEAD` bytes
//! ahead of the reader, and data more than `KEEP_BEHIND` behind it is freed.
//! For seekable resources (originals served with `Accept-Ranges`), reading a
//! region that isn't held, such as after a seek or into freed data, restarts
//! the download there with a Range request.

use std::{
    collections::BTreeMap,
    io::{self, Read, Seek, SeekFrom},
    sync::{Arc, Condvar, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Result, bail};

/// A read this far ahead of the download head waits instead of re-requesting.
const NEAR_HEAD: u64 = 1 << 20;
/// How far the download may run ahead of the reader before pausing.
const READ_AHEAD: u64 = 24 << 20;
/// Data kept behind the reader, for decoders that seek back a little.
const KEEP_BEHIND: u64 = 4 << 20;
/// Storage granularity: memory is allocated and freed in blocks of this size.
const BLOCK: u64 = 256 << 10;
const READ_SIZE: usize = 64 * 1024;

/// Sorted, non-overlapping half-open byte ranges that are held in memory.
#[derive(Default, Debug)]
struct RangeSet(Vec<(u64, u64)>);

impl RangeSet {
    fn add(&mut self, start: u64, end: u64) {
        if start >= end {
            return;
        }
        self.0.push((start, end));
        self.0.sort_unstable();
        let mut merged: Vec<(u64, u64)> = Vec::with_capacity(self.0.len());
        for &(s, e) in &self.0 {
            match merged.last_mut() {
                Some(last) if s <= last.1 => last.1 = last.1.max(e),
                _ => merged.push((s, e)),
            }
        }
        self.0 = merged;
    }

    fn remove(&mut self, start: u64, end: u64) {
        self.0 = self
            .0
            .iter()
            .flat_map(|&(s, e)| [(s, e.min(start)), (s.max(end), e)])
            .filter(|(s, e)| s < e)
            .collect();
    }

    /// End of the held range containing `pos`.
    fn end_of(&self, pos: u64) -> Option<u64> {
        self.0
            .iter()
            .find(|&&(s, e)| s <= pos && pos < e)
            .map(|&(_, e)| e)
    }
}

/// Block storage for a sparse window of the resource.
#[derive(Default)]
struct Blocks(BTreeMap<u64, Box<[u8]>>);

impl Blocks {
    fn write(&mut self, mut offset: u64, mut data: &[u8]) {
        while !data.is_empty() {
            let index = offset / BLOCK;
            let within = (offset % BLOCK) as usize;
            let block = self
                .0
                .entry(index)
                .or_insert_with(|| vec![0; BLOCK as usize].into_boxed_slice());
            let n = data.len().min(BLOCK as usize - within);
            block[within..within + n].copy_from_slice(&data[..n]);
            data = &data[n..];
            offset += n as u64;
        }
    }

    /// Copies held bytes at `offset` into `buf`; the caller guarantees they are held.
    fn read(&self, mut offset: u64, buf: &mut [u8]) {
        let mut done = 0;
        while done < buf.len() {
            let block = &self.0[&(offset / BLOCK)];
            let within = (offset % BLOCK) as usize;
            let n = (buf.len() - done).min(BLOCK as usize - within);
            buf[done..done + n].copy_from_slice(&block[within..within + n]);
            done += n;
            offset += n as u64;
        }
    }

    /// Frees blocks that end before `before`; returns the freed byte ranges.
    fn evict_before(&mut self, before: u64) -> Vec<(u64, u64)> {
        let last = before / BLOCK; // blocks with index < last end at or before `before`
        let freed: Vec<u64> = self.0.range(..last).map(|(&i, _)| i).collect();
        freed
            .into_iter()
            .map(|i| {
                self.0.remove(&i);
                (i * BLOCK, (i + 1) * BLOCK)
            })
            .collect()
    }

    fn held_bytes(&self) -> u64 {
        self.0.len() as u64 * BLOCK
    }
}

#[derive(Default)]
struct State {
    blocks: Blocks,
    ranges: RangeSet,
    /// Total size when known (Content-Length / Content-Range).
    len: Option<u64>,
    /// Byte offset the current request is writing at.
    head: u64,
    /// The reader's position, which paces the download and drives eviction.
    reader_pos: u64,
    /// A request has run to the end of the resource.
    complete: bool,
    error: Option<String>,
    /// Offset a reader needs that the current request won't reach soon.
    wanted: Option<u64>,
    cancelled: bool,
    /// Throughput accounting: bytes received while actively receiving, and for how long.
    received: u64,
    receiving_time: Duration,
}

struct Shared {
    state: Mutex<State>,
    cond: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn wait<'a>(&self, s: MutexGuard<'a, State>, timeout: Duration) -> MutexGuard<'a, State> {
        self.cond
            .wait_timeout(s, timeout)
            .unwrap_or_else(|e| e.into_inner())
            .0
    }
}

/// Download statistics, for bandwidth estimation and buffering decisions.
#[derive(Clone, Copy, Debug, Default)]
pub struct StreamStats {
    pub len: Option<u64>,
    /// Bytes received so far (including any re-downloaded after seeks).
    pub downloaded: u64,
    /// Bytes currently held in memory.
    pub held: u64,
    pub complete: bool,
    /// Measured throughput in kbit/s, once enough data has been timed.
    pub throughput_kbps: Option<f64>,
    pub receiving_time: Duration,
}

/// Owner side of a stream: stats and cancellation. Cloneable.
#[derive(Clone)]
pub struct StreamHandle(Arc<Shared>);

impl StreamHandle {
    pub fn stats(&self) -> StreamStats {
        let s = self.0.lock();
        let secs = s.receiving_time.as_secs_f64();
        StreamStats {
            len: s.len,
            downloaded: s.received,
            held: s.blocks.held_bytes(),
            complete: s.complete,
            throughput_kbps: (secs >= 0.2 && s.received > 32 * 1024)
                .then(|| s.received as f64 * 8.0 / 1000.0 / secs),
            receiving_time: s.receiving_time,
        }
    }

    /// Blocks until `bytes` from the start are available, the stream completes, or `timeout` passes.
    pub fn wait_for(&self, bytes: u64, timeout: Duration) -> Result<StreamStats> {
        let deadline = Instant::now() + timeout;
        let mut s = self.0.lock();
        loop {
            if let Some(err) = &s.error {
                bail!("{err}");
            }
            let available = s.ranges.end_of(0).unwrap_or(0);
            if s.complete || available >= bytes || s.len.is_some_and(|l| available >= l) {
                break;
            }
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            s = self.0.wait(s, deadline - now);
        }
        drop(s);
        Ok(self.stats())
    }

    pub fn cancel(&self) {
        self.0.lock().cancelled = true;
        self.0.cond.notify_all();
    }
}

/// Reader side handed to the decoder.
pub struct RemoteStream {
    shared: Arc<Shared>,
    pos: u64,
    seekable: bool,
}

impl RemoteStream {
    /// Starts downloading `url`. `seekable` enables Range requests (originals only).
    pub fn open(
        http: reqwest::blocking::Client,
        url: String,
        seekable: bool,
    ) -> (Self, StreamHandle) {
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            cond: Condvar::new(),
        });
        let worker = shared.clone();
        thread::Builder::new()
            .name("stream-download".into())
            .spawn(move || download(&worker, &http, &url, seekable))
            .expect("spawning download thread");
        (
            Self {
                shared: shared.clone(),
                pos: 0,
                seekable,
            },
            StreamHandle(shared),
        )
    }

    /// Total size, once the server has reported it.
    pub fn total_len(&self) -> Option<u64> {
        self.shared.lock().len
    }
}

impl Drop for RemoteStream {
    fn drop(&mut self) {
        // The decoder is gone: stop downloading.
        self.shared.lock().cancelled = true;
        self.shared.cond.notify_all();
    }
}

impl Read for RemoteStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let mut s = self.shared.lock();
        loop {
            if let Some(end) = s.ranges.end_of(self.pos) {
                let n = ((end - self.pos) as usize).min(buf.len());
                s.blocks.read(self.pos, &mut buf[..n]);
                self.pos += n as u64;
                s.reader_pos = self.pos;
                for (start, end) in s.blocks.evict_before(self.pos.saturating_sub(KEEP_BEHIND)) {
                    s.ranges.remove(start, end);
                }
                // The downloader may be paused waiting for us to catch up.
                self.shared.cond.notify_all();
                return Ok(n);
            }
            let at_end = match s.len {
                Some(len) => self.pos >= len,
                None => s.complete && self.pos >= s.head,
            };
            if at_end {
                return Ok(0);
            }
            if let Some(err) = &s.error {
                return Err(io::Error::other(err.clone()));
            }
            if s.cancelled {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "stream cancelled",
                ));
            }
            // Behind the head (freed or skipped) or far ahead of it: ask for a request at our position.
            if self.seekable
                && (self.pos < s.head || self.pos > s.head + NEAR_HEAD)
                && s.wanted != Some(self.pos)
            {
                s.wanted = Some(self.pos);
                self.shared.cond.notify_all();
            }
            s = self.shared.wait(s, Duration::from_millis(100));
        }
    }
}

impl Seek for RemoteStream {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let mut s = self.shared.lock();
        let target = match to {
            SeekFrom::Start(p) => Some(p),
            SeekFrom::Current(d) => self.pos.checked_add_signed(d),
            SeekFrom::End(d) => s.len.and_then(|l| l.checked_add_signed(d)),
        };
        let Some(target) = target else {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "seek relative to unknown length",
            ));
        };
        // A live transcode can only be read in order: only positions we hold or are about to receive.
        if !self.seekable && s.ranges.end_of(target).is_none() && target != s.head {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "stream is not seekable",
            ));
        }
        self.pos = target;
        s.reader_pos = target;
        self.shared.cond.notify_all();
        Ok(target)
    }
}

fn download(shared: &Shared, http: &reqwest::blocking::Client, url: &str, seekable: bool) {
    let mut offset = 0u64;
    loop {
        {
            let mut s = shared.lock();
            // After reaching the end, idle until a reader needs a region we no longer hold.
            while s.complete && s.wanted.is_none() && !s.cancelled {
                s = shared.wait(s, Duration::from_millis(200));
            }
            if s.cancelled {
                return;
            }
            if let Some(w) = s.wanted.take() {
                offset = w;
            }
            s.head = offset;
        }
        let mut req = http.get(url);
        if seekable && offset > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={offset}-"));
        }
        let mut res = match req.send().and_then(|r| r.error_for_status()) {
            Ok(r) => r,
            Err(e) => return fail(shared, format!("GET {url}: {e}")),
        };
        if seekable {
            let total = total_length(&res, offset);
            let mut s = shared.lock();
            s.len = s.len.or(total);
        }

        let mut buf = vec![0u8; READ_SIZE];
        let restart = loop {
            // Pace the download: pause while far enough ahead of the reader.
            {
                let mut s = shared.lock();
                while offset > s.reader_pos + READ_AHEAD && s.wanted.is_none() && !s.cancelled {
                    s = shared.wait(s, Duration::from_millis(200));
                }
                if s.cancelled {
                    return;
                }
            }
            let started = Instant::now();
            let n = match res.read(&mut buf) {
                Ok(n) => n,
                Err(e) => return fail(shared, format!("reading {url}: {e}")),
            };
            let mut s = shared.lock();
            if s.cancelled {
                return;
            }
            if n == 0 {
                break false;
            }
            let end = offset + n as u64;
            s.blocks.write(offset, &buf[..n]);
            s.ranges.add(offset, end);
            s.received += n as u64;
            s.receiving_time += started.elapsed();
            offset = end;
            s.head = offset;
            shared.cond.notify_all();
            // A reader needs bytes elsewhere: abandon this request unless we'll get there shortly.
            if let Some(w) = s.wanted {
                if w >= offset && w <= offset + NEAR_HEAD {
                    s.wanted = None;
                } else {
                    break true;
                }
            }
        };
        if !restart {
            shared.lock().complete = true;
            shared.cond.notify_all();
        }
    }
}

/// Full resource length from `Content-Range: bytes a-b/total` or `Content-Length`.
fn total_length(res: &reqwest::blocking::Response, offset: u64) -> Option<u64> {
    if let Some(range) = res.headers().get(reqwest::header::CONTENT_RANGE) {
        return range.to_str().ok()?.rsplit('/').next()?.parse().ok();
    }
    res.content_length().map(|l| l + offset)
}

fn fail(shared: &Shared, msg: String) {
    let mut s = shared.lock();
    if !s.cancelled {
        s.error = Some(msg);
    }
    shared.cond.notify_all();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        sync::atomic::{AtomicUsize, Ordering},
    };

    /// Minimal HTTP/1.1 server with Range support and an optional per-chunk delay.
    fn serve(body: Vec<u8>, delay: Duration) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/file", listener.local_addr().unwrap());
        let requests = Arc::new(AtomicUsize::new(0));
        let count = requests.clone();
        let body = Arc::new(body);
        thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                count.fetch_add(1, Ordering::SeqCst);
                let body = body.clone();
                thread::spawn(move || {
                    let mut reader = BufReader::new(conn.try_clone().unwrap());
                    let mut start = 0usize;
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                        if let Some(v) = line.to_ascii_lowercase().strip_prefix("range: bytes=") {
                            start = v.trim().trim_end_matches('-').parse().unwrap();
                        }
                    }
                    let mut conn = conn;
                    let head = if start > 0 {
                        format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{}/{}\r\nConnection: close\r\n\r\n",
                            body.len() - start,
                            body.len() - 1,
                            body.len()
                        )
                    } else {
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                    };
                    if conn.write_all(head.as_bytes()).is_err() {
                        return;
                    }
                    for chunk in body[start..].chunks(16 * 1024) {
                        if conn.write_all(chunk).is_err() {
                            return;
                        }
                        thread::sleep(delay);
                    }
                });
            }
        });
        (url, requests)
    }

    fn body(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    #[test]
    fn reads_while_downloading() {
        let data = body(300_000);
        let (url, _) = serve(data.clone(), Duration::from_millis(2));
        let (mut stream, handle) = RemoteStream::open(reqwest::blocking::Client::new(), url, true);
        let mut out = Vec::new();
        stream.read_to_end(&mut out).unwrap();
        assert_eq!(out, data);
        // The reader can see the last byte just before the downloader marks completion.
        let deadline = Instant::now() + Duration::from_secs(1);
        while !handle.stats().complete && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(handle.stats().complete);
    }

    #[test]
    fn seeking_ahead_restarts_the_download_at_the_target() {
        let data = body(8 << 20);
        // Slow enough that reaching the end sequentially would take ~10 s.
        let (url, requests) = serve(data.clone(), Duration::from_millis(20));
        let (mut stream, _handle) = RemoteStream::open(reqwest::blocking::Client::new(), url, true);
        let mut first = [0u8; 4];
        stream.read_exact(&mut first).unwrap();

        let started = Instant::now();
        let target = data.len() as u64 - 10;
        stream.seek(SeekFrom::Start(target)).unwrap();
        let mut tail = Vec::new();
        stream.read_to_end(&mut tail).unwrap();
        assert_eq!(tail, &data[target as usize..]);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "seek took {:?}",
            started.elapsed()
        );
        assert!(
            requests.load(Ordering::SeqCst) >= 2,
            "expected a Range request"
        );
    }

    #[test]
    fn unknown_length_streams_end_when_the_server_closes() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/live", listener.local_addr().unwrap());
        thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let mut req = [0u8; 1024];
            let _ = conn.read(&mut req);
            conn.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nhello world")
                .unwrap();
        });
        let (mut stream, _) = RemoteStream::open(reqwest::blocking::Client::new(), url, false);
        let mut out = String::new();
        stream.read_to_string(&mut out).unwrap();
        assert_eq!(out, "hello world");
    }

    #[test]
    fn memory_stays_bounded_and_freed_data_is_refetched() {
        let data = body(64 << 20);
        let (url, requests) = serve(data.clone(), Duration::ZERO);
        let (mut stream, handle) = RemoteStream::open(reqwest::blocking::Client::new(), url, true);
        // Read the first 40 MiB slowly enough for the downloader to run as far ahead as it may.
        let mut chunk = vec![0u8; 1 << 20];
        for i in 0..40 {
            stream.read_exact(&mut chunk).unwrap();
            assert_eq!(&chunk[..], &data[i << 20..(i + 1) << 20]);
            thread::sleep(Duration::from_millis(5));
            let held = handle.stats().held;
            assert!(
                held <= READ_AHEAD + KEEP_BEHIND + 4 * BLOCK,
                "holding {} MiB",
                held >> 20
            );
        }
        // Going back to the start re-requests the freed region.
        let before = requests.load(Ordering::SeqCst);
        stream.seek(SeekFrom::Start(0)).unwrap();
        stream.read_exact(&mut chunk).unwrap();
        assert_eq!(&chunk[..], &data[..1 << 20]);
        assert!(requests.load(Ordering::SeqCst) > before);
    }

    #[test]
    fn range_set_merges_and_removes() {
        let mut r = RangeSet::default();
        r.add(10, 20);
        r.add(0, 5);
        r.add(5, 10);
        r.add(30, 40);
        assert_eq!(r.0, vec![(0, 20), (30, 40)]);
        assert_eq!(r.end_of(7), Some(20));
        assert_eq!(r.end_of(25), None);
        r.remove(5, 35);
        assert_eq!(r.0, vec![(0, 5), (35, 40)]);
    }
}
