// Amendment 12 (W12-A): the board in the launcher's own window.
//
// The window loads the same authenticated URL as 「在網頁開啟任務面板」 (launcher-runtime.json).
// Navigation to anything that is not the board itself (claude://, codex://, other web pages) is
// cancelled in the webview and handed to the operating system instead. Closing the window only
// hides it; the board service keeps running and the tray reopens it. When the service restarts
// (crash recovery, 「重新開啟 Codex」) an open window follows it to the new URL.

use serde::Deserialize;
use std::{
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    webview::NewWindowResponse, AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use super::{append_log, open_url_with_os, show_error_dialog, start_launcher, LauncherState};

pub const BOARD_WINDOW_LABEL: &str = "board";
/// Argument the OS login entry starts the app with; such a start stays in the tray.
pub const AUTOSTART_ARG: &str = "--autostart";
const BOARD_WINDOW_TITLE: &str = "AutoMate Taskboard";
const BOARD_READY_TIMEOUT: Duration = Duration::from_secs(180);
const BOARD_READY_POLL: Duration = Duration::from_millis(500);
/// A stopped service counts as "down" only after this long (crash recovery waits 2 s).
const SERVICE_DOWN_GRACE: Duration = Duration::from_secs(5);
/// Height of the strip at the top of the window that must lie on a monitor.
const TITLE_BAR_HEIGHT: i32 = 32;
/// URL schemes the board may hand to the operating system.
const SYSTEM_SCHEMES: [&str; 5] = ["http", "https", "mailto", "claude", "codex"];
const SERVICE_NOT_RUNNING_MESSAGE: &str =
    "任務面板服務沒有在執行，所以無法開啟面板。\n\n請從系統匣選「重新開啟 Codex」啟動服務後再試一次。";

/// Size and position are remembered; visibility is not (the window is shown on request).
pub fn window_state_flags() -> StateFlags {
    StateFlags::all() & !StateFlags::VISIBLE
}

/// True when the process arguments (program name first) contain `--autostart`.
pub fn is_autostart_launch<I: IntoIterator<Item = String>>(args: I) -> bool {
    args.into_iter().skip(1).any(|arg| arg == AUTOSTART_ARG)
}

#[derive(Default)]
pub struct BoardWindowState {
    board_url: Mutex<Option<Url>>,
    opening: AtomicBool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum BoardNavigation {
    /// Stay in the window (the board's own origin, including its blob: downloads).
    Board,
    /// Cancel in the window and open with the operating system.
    System,
    /// Cancel and ignore.
    Blocked,
}

fn is_board_origin(board_url: Option<&Url>, target: &Url) -> bool {
    let Some(board_url) = board_url else {
        return false;
    };
    // Url::origin() of blob:http://host:port/<uuid> is the inner http origin.
    matches!(target.scheme(), "http" | "https" | "blob")
        && target.origin().is_tuple()
        && target.origin() == board_url.origin()
}

/// Top-level navigation inside the board window.
pub fn classify_board_navigation(board_url: Option<&Url>, target: &Url) -> BoardNavigation {
    if target.scheme() == "about" && target.path() == "blank" {
        return BoardNavigation::Board;
    }
    if is_board_origin(board_url, target) {
        return BoardNavigation::Board;
    }
    if SYSTEM_SCHEMES.contains(&target.scheme()) {
        BoardNavigation::System
    } else {
        BoardNavigation::Blocked
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum NewWindowAction {
    /// Load it in the board window itself (the token URL never goes to the external browser).
    OpenInBoard,
    /// Open with the operating system.
    System,
    /// Ignore.
    Deny,
}

/// `target=_blank` / `window.open` from the board. The webview never creates a second window.
pub fn classify_new_window(board_url: Option<&Url>, target: &Url) -> NewWindowAction {
    if matches!(target.scheme(), "about" | "blob") {
        return NewWindowAction::Deny;
    }
    match classify_board_navigation(board_url, target) {
        BoardNavigation::Board => NewWindowAction::OpenInBoard,
        BoardNavigation::System => NewWindowAction::System,
        BoardNavigation::Blocked => NewWindowAction::Deny,
    }
}

#[derive(Deserialize)]
struct RuntimeDescriptor {
    pid: Option<u32>,
    url: String,
}

/// The board page URL from launcher-runtime.json, only when it was written by the current service
/// child and points at this machine's loopback address.
pub fn board_url_from_descriptor(contents: &str, service_pid: Option<u32>) -> Option<Url> {
    let service_pid = service_pid?;
    let descriptor: RuntimeDescriptor = serde_json::from_str(contents).ok()?;
    if descriptor.pid != Some(service_pid) {
        return None;
    }
    let url = Url::parse(&format!("{}/", descriptor.url.trim_end_matches('/'))).ok()?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost"));
    (matches!(url.scheme(), "http" | "https") && loopback).then_some(url)
}

/// True when the window shows something other than the current board (new port or instance token).
pub fn window_needs_board_url(current: &Url, board_url: &Url) -> bool {
    current.origin() != board_url.origin() || !current.path().starts_with(board_url.path())
}

/// Monitor work area in physical pixels: (x, y, width, height).
pub type MonitorRect = (i32, i32, u32, u32);

/// True when the middle of the window's title bar lies on some monitor, so it can be dragged.
pub fn title_bar_on_screen(position: (i32, i32), width: u32, monitors: &[MonitorRect]) -> bool {
    let x = position.0 as i64 + (width / 2) as i64;
    let y = position.1 as i64 + (TITLE_BAR_HEIGHT / 2) as i64;
    monitors.iter().any(|&(mx, my, mw, mh)| {
        x >= mx as i64 && y >= my as i64 && x < mx as i64 + mw as i64 && y < my as i64 + mh as i64
    })
}

#[derive(Debug, PartialEq, Eq)]
pub enum ServiceCheck {
    Waiting,
    /// Down past the grace period and no start was attempted yet.
    TryStart,
    /// Down past the grace period after a start attempt.
    GiveUp,
}

/// `down_for`: how long the service has had no child in phase `stopped` / `error` (None otherwise).
pub fn service_check(down_for: Option<Duration>, start_attempted: bool) -> ServiceCheck {
    match down_for {
        Some(down) if down >= SERVICE_DOWN_GRACE => {
            if start_attempted {
                ServiceCheck::GiveUp
            } else {
                ServiceCheck::TryStart
            }
        }
        _ => ServiceCheck::Waiting,
    }
}

enum WaitOutcome {
    Ready(Url),
    ServiceNotRunning,
    Superseded,
    TimedOut,
}

fn read_board_url(state: &LauncherState, service_pid: Option<u32>) -> Option<Url> {
    fs::read_to_string(state.data_directory.join("launcher-runtime.json"))
        .ok()
        .and_then(|contents| board_url_from_descriptor(&contents, service_pid))
}

/// Waits for the current service's URL; starts the service once when it stays down.
fn wait_for_board_url(app: &AppHandle, state: &Arc<LauncherState>) -> WaitOutcome {
    let deadline = Instant::now() + BOARD_READY_TIMEOUT;
    let mut down_since: Option<Instant> = None;
    let mut start_attempted = false;
    loop {
        let service_pid = *state.child.lock().unwrap();
        if let Some(url) = read_board_url(state, service_pid) {
            return WaitOutcome::Ready(url);
        }
        let down = service_pid.is_none() && {
            let phase = state.snapshot.lock().unwrap().phase.clone();
            phase == "stopped" || phase == "error"
        };
        if !down {
            down_since = None;
        } else if down_since.is_none() {
            down_since = Some(Instant::now());
        }
        match service_check(down_since.map(|since| since.elapsed()), start_attempted) {
            ServiceCheck::Waiting => {}
            ServiceCheck::TryStart => {
                start_attempted = true;
                down_since = None;
                if state.update_in_progress.load(Ordering::SeqCst) {
                    return WaitOutcome::ServiceNotRunning;
                }
                append_log(state, "Board window requested while the service is down; starting it");
                if let Err(error) = start_launcher(app, state) {
                    append_log(state, &format!("Board window service start failed: {error}"));
                    return WaitOutcome::ServiceNotRunning;
                }
                continue;
            }
            ServiceCheck::GiveUp => return WaitOutcome::ServiceNotRunning,
        }
        if Instant::now() >= deadline {
            return WaitOutcome::TimedOut;
        }
        thread::sleep(BOARD_READY_POLL);
    }
}

/// Waits for the URL of service child `pid`; stops when another child replaced it.
fn wait_for_child_url(state: &LauncherState, pid: u32) -> WaitOutcome {
    let deadline = Instant::now() + BOARD_READY_TIMEOUT;
    loop {
        let service_pid = *state.child.lock().unwrap();
        if service_pid != Some(pid) {
            return WaitOutcome::Superseded;
        }
        if let Some(url) = read_board_url(state, service_pid) {
            return WaitOutcome::Ready(url);
        }
        if Instant::now() >= deadline {
            return WaitOutcome::TimedOut;
        }
        thread::sleep(BOARD_READY_POLL);
    }
}

fn focus_window(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Tray click, 「開啟任務面板」, a second launch and a manual app start all come here.
pub fn request_board_window(app: &AppHandle) {
    let Some(board) = app.try_state::<Arc<BoardWindowState>>() else {
        return;
    };
    let board = Arc::clone(board.inner());
    if let Some(window) = app.get_webview_window(BOARD_WINDOW_LABEL) {
        focus_window(&window);
    }
    if board.opening.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
            board.opening.store(false, Ordering::SeqCst);
            return;
        };
        let state = Arc::clone(state.inner());
        let result = match wait_for_board_url(&app, &state) {
            WaitOutcome::Ready(url) => show_board_window(&app, &board, url, true),
            WaitOutcome::ServiceNotRunning | WaitOutcome::Superseded => {
                append_log(&state, "Board window not opened: the board service is not running");
                Err(SERVICE_NOT_RUNNING_MESSAGE.to_string())
            }
            WaitOutcome::TimedOut => {
                Err("任務面板服務還沒準備好，請稍後再從系統匣開啟。".to_string())
            }
        };
        board.opening.store(false, Ordering::SeqCst);
        if let Err(error) = result {
            append_log(&state, "Board window open failed");
            show_error_dialog(&app, "AutoMate Taskboard 開啟失敗", &error);
        }
    });
}

/// Called whenever a new service child starts (first start, crash recovery, 「重新開啟 Codex」):
/// an existing board window moves to the new URL without being shown or focused.
pub fn follow_service_child(app: &AppHandle, state: &Arc<LauncherState>, pid: u32) {
    if app.get_webview_window(BOARD_WINDOW_LABEL).is_none() {
        return;
    }
    let Some(board) = app.try_state::<Arc<BoardWindowState>>() else {
        return;
    };
    let board = Arc::clone(board.inner());
    let app = app.clone();
    let state = Arc::clone(state);
    thread::spawn(move || {
        if let WaitOutcome::Ready(url) = wait_for_child_url(&state, pid) {
            match show_board_window(&app, &board, url, false) {
                Ok(()) => append_log(&state, &format!("Board window follows service child {pid}")),
                Err(error) => append_log(
                    &state,
                    &format!("Board window could not follow the service: {error}"),
                ),
            }
        }
    });
}

fn hand_to_system(app: &AppHandle, target: &Url) {
    let app = app.clone();
    let target = target.to_string();
    thread::spawn(move || {
        if let Err(error) = open_url_with_os(&target) {
            if let Some(state) = app.try_state::<Arc<LauncherState>>() {
                let scheme = target.split(':').next().unwrap_or_default();
                append_log(&state, &format!("Board link open failed ({scheme}): {error}"));
            }
            show_error_dialog(
                &app,
                "AutoMate Taskboard 連結開啟失敗",
                &format!("系統無法開啟這個連結：{error}\n\n請確認對應的 App 已安裝。"),
            );
        }
    });
}

fn keep_title_bar_on_screen(window: &tauri::WebviewWindow) {
    let (Ok(position), Ok(size), Ok(monitors)) = (
        window.outer_position(),
        window.outer_size(),
        window.available_monitors(),
    ) else {
        return;
    };
    let rects: Vec<MonitorRect> = monitors
        .iter()
        .map(|monitor| {
            let area = monitor.work_area();
            (area.position.x, area.position.y, area.size.width, area.size.height)
        })
        .collect();
    if !rects.is_empty() && !title_bar_on_screen((position.x, position.y), size.width, &rects) {
        let _ = window.center();
    }
}

fn show_board_window(
    app: &AppHandle,
    board: &Arc<BoardWindowState>,
    url: Url,
    focus: bool,
) -> Result<(), String> {
    *board.board_url.lock().unwrap() = Some(url.clone());
    if let Some(window) = app.get_webview_window(BOARD_WINDOW_LABEL) {
        if window
            .url()
            .map(|current| window_needs_board_url(&current, &url))
            .unwrap_or(true)
        {
            window.navigate(url).map_err(|error| error.to_string())?;
        }
        if focus {
            focus_window(&window);
        }
        return Ok(());
    }
    if !focus {
        return Ok(());
    }

    let navigation_app = app.clone();
    let navigation_board = Arc::clone(board);
    let new_window_app = app.clone();
    let new_window_board = Arc::clone(board);
    let window = WebviewWindowBuilder::new(app, BOARD_WINDOW_LABEL, WebviewUrl::External(url))
        .title(BOARD_WINDOW_TITLE)
        .inner_size(1280.0, 840.0)
        .min_inner_size(420.0, 360.0)
        .center()
        .visible(false)
        .zoom_hotkeys_enabled(true)
        // The board drags cards with HTML5 drag and drop, which the native file-drop handler blocks on Windows.
        .disable_drag_drop_handler()
        .on_navigation(move |target| {
            let board_url = navigation_board.board_url.lock().unwrap().clone();
            match classify_board_navigation(board_url.as_ref(), target) {
                BoardNavigation::Board => true,
                BoardNavigation::System => {
                    hand_to_system(&navigation_app, target);
                    false
                }
                BoardNavigation::Blocked => false,
            }
        })
        .on_new_window(move |target, _features| {
            let board_url = new_window_board.board_url.lock().unwrap().clone();
            match classify_new_window(board_url.as_ref(), &target) {
                NewWindowAction::OpenInBoard => {
                    let app = new_window_app.clone();
                    thread::spawn(move || {
                        if let Some(window) = app.get_webview_window(BOARD_WINDOW_LABEL) {
                            let _ = window.navigate(target);
                        }
                    });
                }
                NewWindowAction::System => hand_to_system(&new_window_app, &target),
                NewWindowAction::Deny => {}
            }
            NewWindowResponse::Deny
        })
        .build()
        .map_err(|error| error.to_string())?;

    let close_window = window.clone();
    let close_app = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = close_window.hide();
            let _ = close_app.save_window_state(window_state_flags());
        }
    });
    keep_title_bar_on_screen(&window);
    focus_window(&window);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    fn board() -> Url {
        url("http://127.0.0.1:47833/token-1/")
    }

    #[test]
    fn board_origin_stays_in_the_window() {
        let board = board();
        for target in [
            "http://127.0.0.1:47833/token-1/",
            "http://127.0.0.1:47833/token-1/?task=12#x",
            "http://127.0.0.1:47833/favicon.svg",
            "blob:http://127.0.0.1:47833/b10b0000-0000-4000-8000-000000000003",
            "about:blank",
        ] {
            assert_eq!(
                classify_board_navigation(Some(&board), &url(target)),
                BoardNavigation::Board,
                "{target}"
            );
        }
    }

    #[test]
    fn app_links_and_other_web_pages_go_to_the_system() {
        let board = board();
        for target in [
            "claude://claude.ai/epitaxy/bridge-1",
            "CLAUDE://claude.ai/epitaxy/bridge-1",
            "codex://threads/abc",
            "https://github.com/example",
            "http://127.0.0.1:9999/",
            "http://localhost:47833/token-1/",
            "mailto:someone@example.com",
        ] {
            assert_eq!(
                classify_board_navigation(Some(&board), &url(target)),
                BoardNavigation::System,
                "{target}"
            );
        }
    }

    #[test]
    fn unknown_schemes_are_blocked() {
        let board = board();
        for target in [
            "file:///C:/Windows/System32/cmd.exe",
            "javascript:alert(1)",
            "ms-settings:privacy",
            "ms-msdt:/id PCWDiagnostic",
            "search-ms:query=x",
            "data:text/html,x",
            "blob:https://evil.example/5f0c6e7e",
            "blob:null/5f0c6e7e",
            "about:srcdoc",
        ] {
            assert_eq!(
                classify_board_navigation(Some(&board), &url(target)),
                BoardNavigation::Blocked,
                "{target}"
            );
        }
    }

    #[test]
    fn without_a_board_url_even_loopback_pages_are_handed_off() {
        assert_eq!(
            classify_board_navigation(None, &url("http://127.0.0.1:47833/token-1/")),
            BoardNavigation::System
        );
    }

    #[test]
    fn new_windows_never_open_a_second_webview() {
        let board = board();
        let cases = [
            ("http://127.0.0.1:47833/token-1/api/attachments/7", NewWindowAction::OpenInBoard),
            ("http://127.0.0.1:47833/token-1/", NewWindowAction::OpenInBoard),
            ("https://github.com/example", NewWindowAction::System),
            ("claude://claude.ai/epitaxy/bridge-1", NewWindowAction::System),
            ("codex://threads/abc", NewWindowAction::System),
            ("about:blank", NewWindowAction::Deny),
            ("blob:http://127.0.0.1:47833/5f0c6e7e", NewWindowAction::Deny),
            ("file:///C:/x", NewWindowAction::Deny),
            ("javascript:alert(1)", NewWindowAction::Deny),
        ];
        for (target, expected) in cases {
            assert_eq!(classify_new_window(Some(&board), &url(target)), expected, "{target}");
        }
        assert_eq!(
            classify_new_window(None, &url("http://127.0.0.1:47833/token-1/")),
            NewWindowAction::System
        );
    }

    #[test]
    fn descriptor_must_belong_to_the_current_service_on_loopback() {
        let contents = r#"{"version":1,"pid":4242,"url":"http://127.0.0.1:47833/token-1"}"#;
        assert_eq!(
            board_url_from_descriptor(contents, Some(4242)).map(|url| url.to_string()),
            Some("http://127.0.0.1:47833/token-1/".to_string())
        );
        assert!(board_url_from_descriptor(
            r#"{"pid":1,"url":"http://localhost:47833/t"}"#,
            Some(1)
        )
        .is_some());
        assert_eq!(board_url_from_descriptor(contents, Some(1)), None);
        assert_eq!(board_url_from_descriptor(contents, None), None);
        assert_eq!(board_url_from_descriptor("{", Some(4242)), None);
        assert_eq!(
            board_url_from_descriptor(r#"{"url":"http://127.0.0.1:1/t"}"#, Some(4242)),
            None
        );
        for foreign in [
            r#"{"pid":7,"url":"file:///C:/x"}"#,
            r#"{"pid":7,"url":"https://evil.example/t"}"#,
            r#"{"pid":7,"url":"http://192.168.50.5:47833/t"}"#,
            r#"{"pid":7,"url":"http://127.0.0.1.evil.example:47833/t"}"#,
        ] {
            assert_eq!(board_url_from_descriptor(foreign, Some(7)), None, "{foreign}");
        }
    }

    #[test]
    fn window_reloads_only_when_the_board_moved() {
        let board = board();
        assert!(!window_needs_board_url(&url("http://127.0.0.1:47833/token-1/?task=3"), &board));
        assert!(window_needs_board_url(&url("http://127.0.0.1:47833/token-0/"), &board));
        assert!(window_needs_board_url(&url("http://127.0.0.1:50000/token-1/"), &board));
        assert!(window_needs_board_url(&url("about:blank"), &board));
    }

    #[test]
    fn window_state_does_not_restore_visibility() {
        let flags = window_state_flags();
        assert!(flags.contains(StateFlags::SIZE));
        assert!(flags.contains(StateFlags::POSITION));
        assert!(flags.contains(StateFlags::MAXIMIZED));
        assert!(!flags.contains(StateFlags::VISIBLE));
    }

    #[test]
    fn autostart_argument_is_detected_after_the_program_name() {
        let args = |values: &[&str]| values.iter().map(|value| value.to_string()).collect::<Vec<_>>();
        assert!(is_autostart_launch(args(&["C:\\app.exe", "--autostart"])));
        assert!(!is_autostart_launch(args(&["C:\\app.exe"])));
        assert!(!is_autostart_launch(args(&["--autostart"])));
        assert!(!is_autostart_launch(args(&["C:\\app.exe", "--autostart=1"])));
    }

    #[test]
    fn title_bar_must_be_on_a_monitor() {
        let primary: MonitorRect = (0, 0, 1920, 1040);
        let right: MonitorRect = (1920, 0, 2560, 1400);
        assert!(title_bar_on_screen((100, 100), 1280, &[primary]));
        assert!(title_bar_on_screen((2200, 50), 1280, &[primary, right]));
        // Saved on a monitor that is gone.
        assert!(!title_bar_on_screen((2200, 50), 1280, &[primary]));
        // Only a corner remains on screen: the middle of the title bar is off to the left.
        assert!(!title_bar_on_screen((-1200, 200), 1280, &[primary]));
        // Title bar above the top edge.
        assert!(!title_bar_on_screen((100, -40), 1280, &[primary]));
        assert!(!title_bar_on_screen((100, 100), 1280, &[]));
    }

    #[test]
    fn service_is_started_once_after_the_grace_period() {
        assert_eq!(service_check(None, false), ServiceCheck::Waiting);
        assert_eq!(service_check(Some(Duration::from_secs(2)), false), ServiceCheck::Waiting);
        assert_eq!(service_check(Some(SERVICE_DOWN_GRACE), false), ServiceCheck::TryStart);
        assert_eq!(service_check(Some(Duration::from_secs(2)), true), ServiceCheck::Waiting);
        assert_eq!(service_check(Some(SERVICE_DOWN_GRACE), true), ServiceCheck::GiveUp);
    }
}
