//! Linux 桌面端与 iOS 16.x 的媒体通道：把 [`crate::media::handle`] 挂到一个只监听
//! 127.0.0.1 的 HTTP 服务上。
//!
//! 为什么需要它：Tauri 的自定义协议只对 WebView 自己的资源加载生效，而
//! WebKitGTK 的 `<video>` 交给 GStreamer、iOS 16.x 的 `<video>` 交给 AVFoundation，
//! 两者都只认 http/https/file 这类常规 URI，直接给 `hg://localhost` 打不开；
//! 同时这两套环境都不提供 MediaSource，hls.js 也用不上。播放只能由原生 HLS
//! 完成，而它需要一个真正可取的 HTTP 地址——就是这个服务。
//!
//! iOS 的 AVFoundation 会先发 `Range: bytes=0-1` 之类的探测请求，必须用
//! 206 + Content-Range 回答，否则会判定源不可播放并抛 MediaError 4。
//!
//! 端口固定，前端 `src/api.ts` 的 `LOCAL` 必须与 [`ORIGIN`] 一致。

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};

/// 监听端口。前端硬编码同一个值，两边必须同时改。
pub const PORT: u16 = 17650;

/// 前端与 m3u8 分片改写共用的 origin。
pub const ORIGIN: &str = "http://127.0.0.1:17650";

/// 在后台线程里起服务。绑定失败只记日志（播放会退回自定义协议，大概率失败）。
pub fn start() {
    std::thread::spawn(|| {
        let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
            Ok(listener) => listener,
            Err(err) => {
                eprintln!("[hg] 媒体端口 {PORT} 绑定失败：{err}");
                return;
            }
        };
        eprintln!("[hg] 媒体代理就绪：{ORIGIN}");
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                if let Err(err) = serve(stream) {
                    eprintln!("[hg] 媒体请求失败：{err}");
                }
            });
        }
    });
}

fn serve(mut stream: TcpStream) -> std::io::Result<()> {
    let timeout = Some(std::time::Duration::from_secs(30));
    stream.set_read_timeout(timeout)?;
    stream.set_write_timeout(timeout)?;

    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    // 保留 Range：iOS 的 AVFoundation 原生 HLS 会先发 bytes=0-1 / 0-7 探测，
    // 必须以 206 + Content-Range 回答，否则它会判定源不可播放并抛 MediaError 4。
    let mut headers: Vec<(String, String)> = Vec::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line.trim_end().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }

    let mut request = request_line.split_whitespace();
    let method = request.next().unwrap_or_default();
    let target = request.next().unwrap_or("/");
    if method != "GET" && method != "HEAD" {
        return write_plain(&mut stream, 405, "method not allowed");
    }

    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path, query),
        None => (target, ""),
    };

    let response = tauri::async_runtime::block_on(crate::media::handle(path, query, ORIGIN));
    let (parts, body) = response.into_parts();
    let range = if parts.status == tauri::http::StatusCode::OK {
        parse_byte_range(&headers, body.len())
    } else {
        None
    };

    write_response_with_range(&mut stream, method, parts, &body, range)
}

/// 解析 `Range: bytes=start-end`（含 `start-`）。不支持的写法退回 200 全量。
fn parse_byte_range(headers: &[(String, String)], total: usize) -> Option<(usize, usize)> {
    if total == 0 {
        return None;
    }
    let value = headers
        .iter()
        .find(|(name, _)| name == "range")
        .map(|(_, value)| value.as_str())?;
    let spec = value.trim().strip_prefix("bytes=")?;
    let (start, end) = spec.split_once('-')?;
    let start: usize = start.trim().parse().ok()?;
    if start >= total {
        return None;
    }
    let end = if end.trim().is_empty() {
        total - 1
    } else {
        end.trim().parse::<usize>().ok()?.min(total - 1)
    };
    (end >= start).then_some((start, end))
}

/// 仅测试使用：不带 Range 的普通响应写出。生产路径统一走
/// [`write_response_with_range`]，避免非 test 构建出现 dead_code 警告。
#[cfg(test)]
fn write_response(
    stream: &mut impl Write,
    method: &str,
    parts: tauri::http::response::Parts,
    body: &[u8],
) -> std::io::Result<()> {
    write_response_with_range(stream, method, parts, body, None)
}

fn write_response_with_range(
    stream: &mut impl Write,
    method: &str,
    parts: tauri::http::response::Parts,
    body: &[u8],
    range: Option<(usize, usize)>,
) -> std::io::Result<()> {
    let (status, slice, content_range) = match range {
        Some((start, end)) => (
            tauri::http::StatusCode::PARTIAL_CONTENT,
            &body[start..=end],
            Some(format!("bytes {start}-{end}/{}", body.len())),
        ),
        None => (parts.status, body, None),
    };
    let mut head = String::with_capacity(320);
    head.push_str(&format!(
        "HTTP/1.1 {} {}\r\n",
        status.as_u16(),
        status.canonical_reason().unwrap_or("OK")
    ));
    head.push_str(&format!("Content-Length: {}\r\n", slice.len()));
    if let Some(value) = &content_range {
        head.push_str(&format!("Content-Range: {value}\r\n"));
    }
    for (name, value) in parts.headers.iter() {
        // This server sends a complete body and closes the connection. Do not
        // duplicate media::handle's length/CORS headers or forward framing for
        // an upstream connection (WebKit rejects ambiguous HTTP framing).
        if matches!(
            name.as_str(),
            "content-length" | "transfer-encoding" | "connection" | "access-control-allow-origin"
                | "accept-ranges"
        ) || (content_range.is_some() && name.as_str() == "content-range")
        {
            continue;
        }
        if let Ok(value) = value.to_str() {
            head.push_str(&format!("{}: {}\r\n", name.as_str(), value));
        }
    }
    // AVFoundation / GStreamer 会先探测是否支持分段；明确声明可 Range 避免
    // 播放器直接放弃分段请求（iOS 16 上表现为 MediaError 4）。
    head.push_str("Accept-Ranges: bytes\r\n");
    head.push_str("Access-Control-Allow-Origin: *\r\n");
    head.push_str("Connection: close\r\n\r\n");
    stream.write_all(head.as_bytes())?;
    if method != "HEAD" {
        stream.write_all(slice)?;
    }
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::{parse_byte_range, write_response, write_response_with_range};
    use tauri::http::Response;

    #[test]
    fn get_has_one_authoritative_length_and_cors_header() {
        let (parts, body) = Response::builder()
            .header("Content-Length", "999")
            .header("Transfer-Encoding", "chunked")
            .header("Connection", "keep-alive")
            .header("Access-Control-Allow-Origin", "*")
            .header("Content-Type", "application/vnd.apple.mpegurl")
            .body(b"#EXTM3U\n".to_vec())
            .unwrap()
            .into_parts();
        let mut wire = Vec::new();
        write_response(&mut wire, "GET", parts, &body).unwrap();
        let wire = String::from_utf8(wire).unwrap();
        let (head, data) = wire.split_once("\r\n\r\n").unwrap();
        let headers = head.to_ascii_lowercase();
        assert_eq!(headers.matches("content-length:").count(), 1);
        assert!(headers.contains("content-length: 8\r\n"));
        assert_eq!(headers.matches("access-control-allow-origin:").count(), 1);
        assert_eq!(headers.matches("connection:").count(), 1);
        assert!(headers.ends_with("connection: close"));
        assert!(!headers.contains("transfer-encoding:"));
        assert!(headers.contains("content-type: application/vnd.apple.mpegurl"));
        assert_eq!(data, "#EXTM3U\n");
    }

    #[test]
    fn head_keeps_representation_length_without_sending_body() {
        let (parts, body) = Response::builder()
            .status(206)
            .header("Content-Range", "bytes 0-3/20")
            .body(b"data".to_vec())
            .unwrap()
            .into_parts();
        let mut wire = Vec::new();
        write_response(&mut wire, "HEAD", parts, &body).unwrap();
        let wire = String::from_utf8(wire).unwrap();
        assert!(wire.starts_with("HTTP/1.1 206 Partial Content\r\n"));
        assert!(wire.contains("Content-Length: 4\r\n"));
        assert!(wire.contains("content-range: bytes 0-3/20\r\n"));
        assert!(wire.ends_with("\r\n\r\n"));
    }

    #[test]
    fn byte_range_returns_206_with_content_range() {
        let (parts, body) = Response::builder()
            .status(200)
            .header("Content-Type", "application/vnd.apple.mpegurl")
            .header("Accept-Ranges", "bytes")
            .body(b"#EXTM3U\n".to_vec())
            .unwrap()
            .into_parts();
        let mut wire = Vec::new();
        write_response_with_range(&mut wire, "GET", parts, &body, Some((0, 1))).unwrap();
        let wire = String::from_utf8(wire).unwrap();
        let (head, data) = wire.split_once("\r\n\r\n").unwrap();
        let headers = head.to_ascii_lowercase();
        assert!(head.starts_with("HTTP/1.1 206 "));
        assert!(headers.contains("content-range: bytes 0-1/8\r\n"));
        assert!(headers.contains("content-length: 2\r\n"));
        assert!(headers.contains("accept-ranges: bytes\r\n"));
        assert_eq!(data, "#E");
    }

    #[test]
    fn parse_byte_range_handles_open_ended_and_rejects_invalid() {
        let h = |v: &str| vec![("range".to_string(), v.to_string())];
        assert_eq!(parse_byte_range(&h("bytes=0-1"), 8), Some((0, 1)));
        assert_eq!(parse_byte_range(&h("bytes=0-"), 8), Some((0, 7)));
        assert_eq!(parse_byte_range(&h("bytes=3-99"), 8), Some((3, 7)));
        assert_eq!(parse_byte_range(&h("bytes=8-"), 8), None);
        assert_eq!(parse_byte_range(&h("items=0-1"), 8), None);
        assert_eq!(parse_byte_range(&h("bytes=0-1"), 0), None);
    }
}

fn write_plain(stream: &mut TcpStream, status: u16, message: &str) -> std::io::Result<()> {
    let reason = tauri::http::StatusCode::from_u16(status)
        .ok()
        .and_then(|code| code.canonical_reason())
        .unwrap_or("Error");
    let body = message.as_bytes();
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}
