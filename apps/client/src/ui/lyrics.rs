//! Lyrics for the playing track: fetched when it starts, the current line followed during playback.

use std::{thread, time::Duration};

use hyperplayer::api::types;
use slint::{ModelRc, SharedString, VecModel};

use super::{App, AppWindow, LyricsState, Page, current_track, playback, with_app};

/// Fetches the lyrics of `track_id` unless they're already shown.
pub fn load(track_id: String) {
    let api = with_app(|app| {
        if app.lyrics.as_ref().is_some_and(|l| *l.track_id == track_id) {
            return None;
        }
        app.lyrics = None;
        app.lyric_line = None;
        if let Some(ui) = app.ui.upgrade() {
            show_state(&ui, LyricsState::Loading, &[], "");
        }
        Some(app.api.clone())
    });
    let Some(api) = api else { return };
    thread::spawn(move || {
        let result = api.lyrics(&track_id);
        let _ = slint::invoke_from_event_loop(move || {
            with_app(|app| {
                // Moved on to another track meanwhile.
                if current_track(app).map(|t| t.id.as_str()) != Some(track_id.as_str()) {
                    return;
                }
                let Some(ui) = app.ui.upgrade() else { return };
                match result {
                    Ok(lyrics) => {
                        show(&ui, &lyrics);
                        app.lyrics = Some(lyrics);
                    }
                    Err(e) => {
                        eprintln!("lyrics: {e:#}");
                        show_state(&ui, LyricsState::None, &[], "");
                    }
                }
            })
        });
    });
}

fn show(ui: &AppWindow, lyrics: &types::Lyrics) {
    let state = match lyrics.source {
        _ if lyrics.instrumental => LyricsState::Instrumental,
        types::LyricsSource::None => LyricsState::None,
        _ if lyrics.synced => LyricsState::Synced,
        _ => LyricsState::Plain,
    };
    let source = match lyrics.source {
        types::LyricsSource::Lrclib => "Lyrics from LRCLIB",
        types::LyricsSource::File => "Lyrics from a .lrc file",
        types::LyricsSource::Tags => "Lyrics from the file's tags",
        types::LyricsSource::None => "",
    };
    show_state(ui, state, &lyrics.lines, source);
}

fn show_state(ui: &AppWindow, state: LyricsState, lines: &[types::LyricLine], source: &str) {
    let lines: Vec<SharedString> = lines.iter().map(|l| l.text.as_str().into()).collect();
    ui.set_lyrics_lines(ModelRc::new(VecModel::from(lines)));
    ui.set_lyrics_state(state);
    ui.set_lyrics_source(source.into());
    ui.set_lyrics_current(-1);
}

/// Called from the playback tick: highlights the line being sung.
pub fn follow(app: &mut App, position: Duration) {
    let Some(lyrics) = app.lyrics.as_ref().filter(|l| l.synced) else {
        return;
    };
    let ms = position.as_millis() as i64;
    let line = lyrics
        .lines
        .iter()
        .rposition(|l| l.time_ms.is_some_and(|t| t <= ms));
    if line != app.lyric_line {
        app.lyric_line = line;
        if let Some(ui) = app.ui.upgrade() {
            ui.set_lyrics_current(line.map_or(-1, |i| i as i32));
        }
    }
}

/// A click on a synced line: jump there.
pub fn seek_to_line(index: i32) {
    let at = with_app(|app| {
        let lyrics = app.lyrics.as_ref()?;
        lyrics.lines.get(usize::try_from(index).ok()?)?.time_ms
    });
    if let Some(ms) = at {
        playback::seek_to(Duration::from_millis(ms.max(0) as u64));
    }
}

pub fn toggle_page() {
    with_app(|app| {
        let Some(ui) = app.ui.upgrade() else { return };
        if ui.get_page() == Page::Lyrics {
            ui.set_page(app.page_before_lyrics);
        } else {
            app.page_before_lyrics = ui.get_page();
            ui.set_page(Page::Lyrics);
        }
    });
}
