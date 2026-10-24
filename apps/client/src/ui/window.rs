//! Our own title bar (the desktop's is hidden): moving, resizing, maximising and
//! the window buttons go through the compositor, so they behave like any other
//! window's, and the buttons follow the desktop's layout setting.

use std::process::Command;

use slint::{
    ComponentHandle, ModelRc, SharedString, VecModel,
    winit_030::{WinitWindowAccessor, winit::window::ResizeDirection},
};

use super::{AppWindow, with_app};

/// The desktop's title-bar button layout, e.g. `close,minimize,maximize:` (buttons
/// before the colon go on the left). GNOME-family desktops store it in gsettings;
/// elsewhere the common right-hand layout applies.
fn button_layout() -> (Vec<String>, Vec<String>) {
    let layout = Command::new("gsettings")
        .args(["get", "org.gnome.desktop.wm.preferences", "button-layout"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim()
                .trim_matches('\'')
                .to_string()
        })
        .unwrap_or_else(|| ":minimize,maximize,close".into());
    parse_layout(&layout)
}

fn parse_layout(layout: &str) -> (Vec<String>, Vec<String>) {
    let (left, right) = layout.split_once(':').unwrap_or(("", layout));
    let side = |s: &str| {
        s.split(',')
            .map(str::trim)
            .filter(|b| matches!(*b, "close" | "minimize" | "maximize"))
            .map(String::from)
            .collect()
    };
    (side(left), side(right))
}

pub fn init(ui: &AppWindow, system_title_bar: bool) {
    ui.set_custom_title_bar(!system_title_bar);
    let (left, right) = button_layout();
    let model = |v: Vec<String>| {
        ModelRc::new(VecModel::from(
            v.into_iter().map(SharedString::from).collect::<Vec<_>>(),
        ))
    };
    ui.set_title_buttons_left(model(left));
    ui.set_title_buttons_right(model(right));

    ui.on_window_drag(|| with_window(|w| drop(w.drag_window())));
    ui.on_window_resize(|edge| {
        let direction = match edge.as_str() {
            "n" => ResizeDirection::North,
            "s" => ResizeDirection::South,
            "e" => ResizeDirection::East,
            "w" => ResizeDirection::West,
            "ne" => ResizeDirection::NorthEast,
            "nw" => ResizeDirection::NorthWest,
            "se" => ResizeDirection::SouthEast,
            _ => ResizeDirection::SouthWest,
        };
        with_window(|w| drop(w.drag_resize_window(direction)));
    });
    ui.on_window_button(|button| {
        let Some(ui) = with_app(|app| app.ui.upgrade()) else {
            return;
        };
        let window = ui.window();
        match button.as_str() {
            "close" => {
                let _ = ui.hide();
            }
            "minimize" => window.set_minimized(true),
            _ => {
                window.set_maximized(!window.is_maximized());
                ui.set_window_maximized(window.is_maximized());
            }
        }
    });
}

/// Keeps the maximise button's icon right when the desktop maximises the window itself.
pub fn sync(ui: &AppWindow) {
    let maximized = ui.window().is_maximized();
    if ui.get_window_maximized() != maximized {
        ui.set_window_maximized(maximized);
    }
}

fn with_window(f: impl FnOnce(&slint::winit_030::winit::window::Window)) {
    if let Some(ui) = with_app(|app| app.ui.upgrade()) {
        ui.window().with_winit_window(f);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_gnome_button_layouts() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(
            parse_layout("close,minimize,maximize:"),
            (s(&["close", "minimize", "maximize"]), s(&[]))
        );
        assert_eq!(
            parse_layout("appmenu:minimize,maximize,close"),
            (s(&[]), s(&["minimize", "maximize", "close"]))
        );
        assert_eq!(parse_layout(":close"), (s(&[]), s(&["close"])));
    }
}
