//! The service's settings: `server.env` as the installer writes it, and the network
//! shares the music folders are on. Portable, so it's tested on any platform.

use std::collections::BTreeMap;

/// The installer writes UTF-16 (with a byte order mark); edited by hand it may be UTF-8.
pub fn decode(bytes: &[u8]) -> String {
    match bytes {
        [0xff, 0xfe, rest @ ..] => {
            let units: Vec<u16> = rest
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| u16::from_le_bytes(*c))
                .collect();
            String::from_utf16_lossy(&units)
        }
        [0xef, 0xbb, 0xbf, rest @ ..] => String::from_utf8_lossy(rest).into_owned(),
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// `KEY='value'` / `KEY=value` lines; `#` starts a comment.
pub fn parse_settings(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| {
            let v = v.trim();
            let v = v
                .strip_prefix('\'')
                .and_then(|v| v.strip_suffix('\''))
                .unwrap_or(v);
            (k.trim().to_string(), v.to_string())
        })
        .collect()
}

/// `\\server\share` of each library folder on a network share.
pub fn shares(library: &str) -> Vec<String> {
    let mut shares: Vec<String> = library
        .split(';')
        .filter_map(|p| {
            let rest = p.trim().strip_prefix(r"\\")?;
            let mut parts = rest.split('\\').filter(|s| !s.is_empty());
            Some(format!(r"\\{}\{}", parts.next()?, parts.next()?))
        })
        .collect();
    shares.sort();
    shares.dedup();
    shares
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_installers_settings() {
        let text = "# comment\r\nHP_LIBRARY='D:\\Musica è;\\\\nas\\Music'\r\nHP_PORT=4533\r\n";
        let utf16: Vec<u8> = [0xff, 0xfe]
            .into_iter()
            .chain(text.encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        let settings = parse_settings(&decode(&utf16));
        assert_eq!(settings["HP_LIBRARY"], r"D:\Musica è;\\nas\Music");
        assert_eq!(settings["HP_PORT"], "4533");
    }

    #[test]
    fn finds_the_shares_of_library_folders() {
        assert_eq!(
            shares(r"\\vault\storage\Music\Lidarr;D:\Music;\\vault\storage\Other;\\nas\Media"),
            vec![r"\\nas\Media".to_string(), r"\\vault\storage".to_string()]
        );
    }
}
