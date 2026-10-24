//! Smart playlists: the templates the sidebar's "+" offers, and the rule editor on their page.

use std::{num::NonZeroU64, rc::Rc};

use hyperplayer::api::types::{
    self, SmartField as F, SmartOperator as Op, SmartRule, SmartRules, SmartRulesMatch,
    SmartRulesOrder,
};
use slint::{ModelRc, SharedString, VecModel};

use super::{App, AppWindow, RuleRow, background, library, with_app};

/// The editor's fields and orders, in the order its lists show them (app.slint).
const FIELDS: [F; 12] = [
    F::Title,
    F::Artist,
    F::Album,
    F::Genre,
    F::Format,
    F::Year,
    F::Duration,
    F::SampleRate,
    F::Plays,
    F::Lossless,
    F::LastPlayed,
    F::Added,
];
const ORDERS: [SmartRulesOrder; 8] = [
    SmartRulesOrder::Random,
    SmartRulesOrder::Title,
    SmartRulesOrder::Artist,
    SmartRulesOrder::Album,
    SmartRulesOrder::Year,
    SmartRulesOrder::Added,
    SmartRulesOrder::Plays,
    SmartRulesOrder::LastPlayed,
];
/// The server's cap on a smart playlist's length.
const MAX_LIMIT: u64 = 500;

/// The operators a field takes (as the server checks them).
fn ops(field: F) -> &'static [Op] {
    match field {
        F::Title | F::Artist | F::Album | F::Genre | F::Format => &[
            Op::Contains,
            Op::NotContains,
            Op::Is,
            Op::IsNot,
            Op::StartsWith,
        ],
        F::Year | F::Duration | F::SampleRate | F::Plays => &[
            Op::Is,
            Op::IsNot,
            Op::LessThan,
            Op::GreaterThan,
            Op::Between,
        ],
        F::Lossless => &[Op::Is],
        F::LastPlayed => &[Op::InLast, Op::NotInLast, Op::Never],
        F::Added => &[Op::InLast, Op::NotInLast],
    }
}

/// How an operator reads after its field ("Year before", "Duration longer than").
fn op_label(field: F, op: Op) -> &'static str {
    match (field, op) {
        (_, Op::Contains) => "contains",
        (_, Op::NotContains) => "doesn't contain",
        (_, Op::Is) => "is",
        (_, Op::IsNot) => "is not",
        (_, Op::StartsWith) => "starts with",
        (F::Year, Op::LessThan) => "before",
        (F::Year, Op::GreaterThan) => "after",
        (F::Duration, Op::LessThan) => "shorter than",
        (F::Duration, Op::GreaterThan) => "longer than",
        (_, Op::LessThan) => "less than",
        (_, Op::GreaterThan) => "more than",
        (_, Op::Between) => "between",
        (_, Op::InLast) => "in the last",
        (_, Op::NotInLast) => "not in the last",
        (_, Op::Never) => "never",
    }
}

/// What to type for a field's value.
fn hint(field: F) -> &'static str {
    match field {
        F::Title | F::Artist | F::Album => "name",
        F::Genre => "genre, e.g. Jazz",
        F::Format => "e.g. FLAC",
        F::Year => "e.g. 1975",
        F::Duration => "seconds or m:ss",
        F::SampleRate => "kHz, e.g. 96",
        F::Plays => "times",
        F::Lossless => "yes or no",
        F::LastPlayed | F::Added => "days",
    }
}

fn rule(field: F, op: Op) -> SmartRule {
    SmartRule {
        field,
        op,
        value: value(""),
        value2: value2(""),
    }
}

/// A rule value, cut to what the server takes.
fn value(text: &str) -> types::SmartRuleValue {
    let text: String = text.chars().take(200).collect();
    text.try_into()
        .expect("a rule value of at most 200 characters")
}

fn value2(text: &str) -> types::SmartRuleValue2 {
    let text: String = text.chars().take(200).collect();
    text.try_into()
        .expect("a rule value of at most 200 characters")
}

fn rules(rules: Vec<SmartRule>, order: SmartRulesOrder, limit: u64) -> SmartRules {
    SmartRules {
        match_: SmartRulesMatch::All,
        rules,
        order,
        descending: false,
        limit: NonZeroU64::new(limit).expect("a limit above zero"),
    }
}

/// The rules being edited on a smart playlist's page, until applied.
pub struct Editing {
    playlist: String,
    rules: SmartRules,
    dirty: bool,
}

/// A smart playlist template from the sidebar's "+": created, then opened to be filled in.
pub fn template(kind: &str) -> Option<(&'static str, SmartRules)> {
    Some(match kind {
        "random" => ("Random mix", rules(vec![], SmartRulesOrder::Random, 50)),
        "artist" => (
            "Artist mix",
            rules(vec![rule(F::Artist, Op::Is)], SmartRulesOrder::Random, 100),
        ),
        "albums" => (
            "Album mix",
            rules(
                vec![rule(F::Album, Op::Contains)],
                SmartRulesOrder::Album,
                100,
            ),
        ),
        "genre" => (
            "Genre mix",
            rules(vec![rule(F::Genre, Op::Is)], SmartRulesOrder::Random, 100),
        ),
        "custom" => (
            "Smart playlist",
            rules(
                vec![rule(F::Title, Op::Contains)],
                SmartRulesOrder::Random,
                100,
            ),
        ),
        _ => return None,
    })
}

/// A playlist was shown: the editor follows it, keeping unapplied edits to the same one.
pub fn show(app: &mut App, ui: &AppWindow, p: &types::Playlist, fresh: bool) {
    let Some(rules) = &p.rules else {
        app.smart = None;
        ui.set_smart_playlist(false);
        return;
    };
    let keep = app
        .smart
        .as_ref()
        .is_some_and(|e| e.playlist == p.id.as_str() && e.dirty);
    if !keep {
        app.smart = Some(Editing {
            playlist: p.id.to_string(),
            rules: rules.clone(),
            dirty: false,
        });
    }
    ui.set_smart_playlist(true);
    if fresh {
        // A template's rules want filling in first.
        let blank = rules
            .rules
            .iter()
            .any(|r| r.value.is_empty() && r.op != Op::Never);
        let hint = if blank {
            "Fill in the rules, then apply them."
        } else {
            ""
        };
        ui.set_smart_message(hint.into());
    }
    push(app, ui);
}

/// Shows the rules being edited.
fn push(app: &App, ui: &AppWindow) {
    let Some(e) = &app.smart else { return };
    let rows: Vec<RuleRow> = e
        .rules
        .rules
        .iter()
        .map(|r| {
            let ops = ops(r.field);
            RuleRow {
                field: FIELDS.iter().position(|f| *f == r.field).unwrap_or(0) as i32,
                ops: ModelRc::new(VecModel::from(
                    ops.iter()
                        .map(|op| SharedString::from(op_label(r.field, *op)))
                        .collect::<Vec<_>>(),
                )),
                op: ops.iter().position(|op| *op == r.op).unwrap_or(0) as i32,
                value: r.value.as_str().into(),
                value2: r.value2.as_str().into(),
                hint: hint(r.field).into(),
                needs_value: r.op != Op::Never,
                between: r.op == Op::Between,
            }
        })
        .collect();
    ui.set_smart_rules(Rc::new(VecModel::from(rows)).into());
    ui.set_smart_match_any(e.rules.match_ == SmartRulesMatch::Any);
    ui.set_smart_order(ORDERS.iter().position(|o| *o == e.rules.order).unwrap_or(0) as i32);
    ui.set_smart_descending(e.rules.descending);
    ui.set_smart_limit(e.rules.limit.to_string().into());
    ui.set_smart_dirty(e.dirty);
}

/// Changes the rules being edited; `redraw` when the editor's rows change shape (not for typing).
fn edit(redraw: bool, change: impl FnOnce(&mut SmartRules)) {
    with_app(|app| {
        let Some(e) = app.smart.as_mut() else { return };
        change(&mut e.rules);
        e.dirty = true;
        if let Some(ui) = app.ui.upgrade() {
            ui.set_smart_dirty(true);
            ui.set_smart_message("".into());
            if redraw {
                push(app, &ui);
            }
        }
    });
}

pub fn set_match(any: bool) {
    edit(true, |r| {
        r.match_ = if any {
            SmartRulesMatch::Any
        } else {
            SmartRulesMatch::All
        }
    });
}

pub fn set_field(index: i32, field: i32) {
    let Some(&field) = FIELDS.get(field as usize) else {
        return;
    };
    edit(true, |r| {
        if let Some(rule) = r.rules.get_mut(index as usize)
            && rule.field != field
        {
            // Another kind of value: start that afresh.
            *rule = self::rule(field, ops(field)[0]);
        }
    });
}

pub fn set_op(index: i32, op: i32) {
    edit(true, |r| {
        if let Some(rule) = r.rules.get_mut(index as usize)
            && let Some(&op) = ops(rule.field).get(op as usize)
        {
            rule.op = op;
        }
    });
}

pub fn set_value(index: i32, text: SharedString) {
    edit(false, |r| {
        if let Some(rule) = r.rules.get_mut(index as usize) {
            rule.value = value(&text);
        }
    });
}

pub fn set_value2(index: i32, text: SharedString) {
    edit(false, |r| {
        if let Some(rule) = r.rules.get_mut(index as usize) {
            rule.value2 = value2(&text);
        }
    });
}

pub fn remove_rule(index: i32) {
    edit(true, |r| {
        if (index as usize) < r.rules.len() {
            r.rules.remove(index as usize);
        }
    });
}

pub fn add_rule() {
    edit(true, |r| {
        if r.rules.len() < 20 {
            r.rules.push(rule(F::Artist, Op::Is));
        }
    });
}

pub fn set_order(order: i32) {
    let Some(&order) = ORDERS.get(order as usize) else {
        return;
    };
    edit(true, |r| r.order = order);
}

pub fn set_descending(on: bool) {
    edit(false, |r| r.descending = on);
}

pub fn set_limit(text: SharedString) {
    // Anything that isn't a number keeps the last limit; 500 at most.
    if let Ok(n) = text.trim().parse::<u64>() {
        edit(false, |r| {
            r.limit = NonZeroU64::new(n.clamp(1, MAX_LIMIT)).expect("a limit above zero")
        });
    }
}

/// Saves the rules: the playlist then shows what they match.
pub fn apply() {
    let Some((api, id, rules)) = with_app(|app| {
        let e = app.smart.as_ref()?;
        Some((app.api.clone(), e.playlist.clone(), e.rules.clone()))
    }) else {
        return;
    };
    std::thread::spawn(move || {
        let result = api.set_playlist_rules(&id, rules);
        let _ = slint::invoke_from_event_loop(move || match result {
            Ok(p) => {
                with_app(|app| {
                    if let Some(e) = app.smart.as_mut() {
                        e.dirty = false;
                    }
                    if let Some(ui) = app.ui.upgrade() {
                        // The limit as applied, in case it was clamped.
                        push(app, &ui);
                    }
                });
                library::playlist_changed(p, false);
            }
            Err(e) => with_app(|app| {
                if let Some(ui) = app.ui.upgrade() {
                    // The server's own words ("\"nineteen\" isn't a number (year)") are the useful part.
                    let msg = format!("{e:#}");
                    ui.set_smart_message(msg.rsplit(": ").next().unwrap_or(&msg).into());
                }
            }),
        });
    });
}

/// "Save as playlist": an ordinary playlist with what matches now, opened to edit by hand.
pub fn save_copy() {
    let Some((api, name, tracks)) = with_app(|app| {
        let p = app.playlist.as_ref()?;
        let tracks: Vec<types::Id> = p
            .entries
            .iter()
            .filter_map(|e| e.track.as_ref().map(|t| t.id.clone()))
            .collect();
        Some((
            app.api.clone(),
            library::fresh_name(app, &format!("{} (saved)", p.name)),
            tracks,
        ))
    }) else {
        return;
    };
    background(
        move || api.create_playlist(&name, tracks),
        |p| library::playlist_changed(p, true),
    );
}
