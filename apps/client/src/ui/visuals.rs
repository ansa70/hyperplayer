//! The waveform seek bar and the live spectrum.

use std::{collections::HashMap, rc::Rc, time::Duration};

use hyperplayer::{
    api::Api,
    spectrum::{Analyzer, WINDOW},
};
use slint::{Model, ModelRc, Timer, TimerMode, VecModel};

use super::{App, AppWindow, background, current_track, with_app};

/// Bars in the spectrum.
const BANDS: usize = 28;
const FRAME: Duration = Duration::from_millis(33);
/// Waveforms kept for tracks played or about to be (they're small).
const KEEP: usize = 16;

pub struct Visuals {
    waveforms: HashMap<String, Rc<VecModel<f32>>>,
    /// Least recently used first.
    order: Vec<String>,
    analyzer: Analyzer,
    bars: Rc<VecModel<f32>>,
    samples: Vec<f32>,
    /// The bars are at rest (nothing to redraw until playback resumes).
    idle: bool,
}

impl Default for Visuals {
    fn default() -> Self {
        Self {
            waveforms: HashMap::new(),
            order: Vec::new(),
            analyzer: Analyzer::new(BANDS),
            bars: Rc::new(VecModel::from(vec![0.0; BANDS])),
            samples: vec![0.0; WINDOW],
            idle: true,
        }
    }
}

/// Starts the spectrum's frame timer; called once.
pub fn init(ui: &AppWindow) {
    let bars = with_app(|app| app.visuals.bars.clone());
    ui.set_spectrum(ModelRc::from(bars));
    let timer = Box::leak(Box::new(Timer::default()));
    timer.start(TimerMode::Repeated, FRAME, || with_app(frame));
}

fn frame(app: &mut App) {
    let on = app.appearance.visualizer;
    if let Some(ui) = app.ui.upgrade()
        && ui.get_visualizer() != on
    {
        ui.set_visualizer(on);
    }
    let playing = app.audio.as_ref().is_some_and(|a| !a.is_paused());
    let pipeline = app.session.as_ref().map(|s| &s.pipeline);
    if let Some(p) = pipeline {
        // Recording costs the audio thread a little: only while someone looks.
        p.set_tap(on);
    }
    let v = &mut app.visuals;
    if !on {
        return;
    }
    let levels = match pipeline {
        Some(p) if playing => {
            p.latest_played(&mut v.samples);
            v.idle = false;
            v.analyzer.update(&v.samples, p.sample_rate())
        }
        _ if v.idle => return,
        _ => v.analyzer.decay(),
    };
    let mut moving = false;
    for (i, &level) in levels.iter().enumerate() {
        moving |= level > 0.005;
        if v.bars
            .row_data(i)
            .is_none_or(|old| (old - level).abs() > 0.002)
        {
            v.bars.set_row_data(i, level);
        }
    }
    if !playing && !moving {
        v.idle = true;
    }
}

/// Shows `track_id`'s waveform in the seek bar, fetching it if needed.
pub fn show_waveform(track_id: String) {
    let cached = with_app(|app| {
        let ui = app.ui.upgrade()?;
        match app.visuals.waveforms.get(&track_id).cloned() {
            Some(model) => {
                touch(app, &track_id);
                ui.set_waveform(ModelRc::from(model));
                ui.set_waveform_ready(true);
                Some(true)
            }
            None => {
                ui.set_waveform_ready(false);
                Some(false)
            }
        }
    });
    if cached == Some(false) {
        fetch(with_app(|app| app.api.clone()), track_id, true);
    }
}

/// Fetches a waveform ahead of time (the next track, while it preloads).
pub fn prefetch(app: &App, track_id: String) {
    if !app.visuals.waveforms.contains_key(&track_id) {
        fetch(app.api.clone(), track_id, false);
    }
}

fn fetch(api: Api, track_id: String, show: bool) {
    let id = track_id.clone();
    background(
        move || api.waveform(&id),
        move |w| {
            with_app(|app| {
                let points: Vec<f32> = w.points.iter().map(|&p| p as f32 / 100.0).collect();
                let model = Rc::new(VecModel::from(points));
                app.visuals
                    .waveforms
                    .insert(track_id.clone(), model.clone());
                touch(app, &track_id);
                // Still the track playing?
                if show
                    && current_track(app).is_some_and(|t| t.id.as_str() == track_id)
                    && let Some(ui) = app.ui.upgrade()
                {
                    ui.set_waveform(ModelRc::from(model));
                    ui.set_waveform_ready(true);
                }
            })
        },
    );
}

fn touch(app: &mut App, track_id: &str) {
    let v = &mut app.visuals;
    v.order.retain(|t| t != track_id);
    v.order.push(track_id.to_string());
    while v.order.len() > KEEP {
        let old = v.order.remove(0);
        v.waveforms.remove(&old);
    }
}
