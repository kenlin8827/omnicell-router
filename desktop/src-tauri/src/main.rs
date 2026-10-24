// Prevents an extra console window on Windows in release builds (the shell
// itself is a GUI binary; keep the console in dev for logs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// OmniCellRouter desktop shell (Tauri v2).
//
// Lifecycle: (optionally) spawn the gateway sidecar next to this binary,
// wait for its /health, then open a window on the console UI the gateway
// serves at http://127.0.0.1:<port>/admin/. The sidecar is killed on exit.
//
// Window close follows the STANDARD desktop contract — X exits the app and
// stops the gateway. Tray residency is OPT-IN via the tray menu checkbox
// "Close to tray" (persisted in <OCR_HOME>/desktop.json); when enabled, X
// hides the window and only the tray Quit really exits.
//
// The gateway binary is produced by `bun run sidecar` (bun build --compile
// of backend/src/index.ts) and declared as Tauri externalBin "bin/ocr-backend"
// — Tauri copies it next to the app binary at build time, so both the
// installed layout and target/release lookups share the same parent dir.

use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;

const PORT: u16 = 4000;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);

/// Windows: spawn the console-subsystem sidecar WITHOUT a console host window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Sidecar file name: Tauri's bundler strips the `-{target}` triple suffix
/// from externalBin, so the installed name is `ocr-backend.exe` on Windows
/// and extensionless `ocr-backend` on macOS/Linux.
#[cfg(windows)]
const SIDECAR_FILE: &str = "ocr-backend.exe";
#[cfg(not(windows))]
const SIDECAR_FILE: &str = "ocr-backend";

/// True when something already answers GET /health with 200 on the port
/// (an existing `ocr start` daemon — adopt it instead of spawning).
fn health_ok(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let req = format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 256];
    let n = stream.read(&mut buf).unwrap_or(0);
    String::from_utf8_lossy(&buf[..n]).contains(" 200")
}

fn wait_health(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if health_ok(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}

struct GatewayState {
    child: Mutex<Option<Child>>,
    /// OCR_HOME we launched the gateway with — set ONLY when we spawned it
    /// ourselves. An adopted pre-existing gateway stays under its own
    /// management (`ocr stop` / console stop).
    home: Mutex<Option<std::path::PathBuf>>,
    /// Opt-in tray residency: when true, a window close hides to tray
    /// instead of exiting. Default false — X means exit. Persisted in
    /// <OCR_HOME>/desktop.json.
    close_to_tray: AtomicBool,
    /// Handle to the tray checkbox so the menu event handler can sync the
    /// visual state with our persisted value.
    close_to_tray_item: Mutex<Option<tauri::menu::CheckMenuItem<tauri::Wry>>>,
}

fn settings_path(home: &std::path::Path) -> std::path::PathBuf {
    home.join("desktop.json")
}

/// Missing or corrupt file = default (false). The file is shell-owned and
/// contains a single key, so a strict read is fine.
fn load_close_to_tray(home: &std::path::Path) -> bool {
    fs::read_to_string(settings_path(home))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("closeToTray").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

fn save_close_to_tray(home: &std::path::Path, enabled: bool) {
    let _ = fs::create_dir_all(home);
    let _ = fs::write(
        settings_path(home),
        format!("{{\"closeToTray\":{enabled}}}"),
    );
}

/// Persist the window's last OUTER physical bounds — the standard "remember
/// my geometry" contract. The restore path compensates for the chrome delta
/// (outer − client) measured at restore time; persisting inner would grow the
/// window by that delta on every restart cycle. Merges into desktop.json so
/// closeToTray survives. Called from CloseRequested — both the exit path and
/// the tray-hide path.
fn persist_window_bounds(
    home: &std::path::Path,
    win: &tauri::Window,
) {
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
        return;
    };
    let mut v: serde_json::Value = fs::read_to_string(settings_path(home))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::json!({}));
    v["window"] = serde_json::json!({
        "x": pos.x, "y": pos.y, "w": size.width, "h": size.height
    });
    let _ = fs::create_dir_all(home);
    let _ = fs::write(settings_path(home), serde_json::to_string(&v).unwrap_or_default());
}

/// Saved bounds sanity: nonzero, positive origin, and at least a usable
/// window. Corrupt entries fall back to the first-run default.
fn load_window_bounds(home: &std::path::Path) -> Option<(i32, i32, u32, u32)> {
    let v: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(settings_path(home)).ok()?,
    )
    .ok()?;
    let w = v.get("window")?;
    let (x, y) = (w.get("x")?.as_i64()? as i32, w.get("y")?.as_i64()? as i32);
    let (wd, ht) = (w.get("w")?.as_u64()? as u32, w.get("h")?.as_u64()? as u32);
    if wd < 400 || ht < 300 {
        return None;
    }
    Some((x, y, wd, ht))
}

/// The gateway may have REPLACED itself via the console restart route — that
/// replacement is a detached grandchild, not our direct child, so
/// `child.kill()` misses it. Kill the pid-file process tree instead so a
/// window close truly stops everything we started.
#[cfg(windows)]
fn kill_gateway_tree(home: &std::path::Path) {
    let Ok(pid) = fs::read_to_string(home.join("ocr.pid")) else {
        return;
    };
    let pid = pid.trim();
    if pid.is_empty() || !pid.chars().all(|c| c.is_ascii_digit()) {
        return;
    }
    let mut kill = Command::new("taskkill");
    kill.args(["/F", "/T", "/PID", pid])
        .creation_flags(CREATE_NO_WINDOW);
    let _ = kill.output();
}

/// POSIX: the gateway may have REPLACED itself via the console restart
/// route (detached grandchild, not our direct child) — deliver SIGTERM to
/// the pid-file pid so a window close stops everything we started.
#[cfg(not(windows))]
fn kill_gateway_tree(home: &std::path::Path) {
    let Ok(pid) = fs::read_to_string(home.join("ocr.pid")) else {
        return;
    };
    let Ok(pid) = pid.trim().parse::<i32>() else {
        return;
    };
    // SAFETY: kill(2) with a validated numeric pid; EPERM/ESRCH are ignored
    // (the gateway may already be gone).
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Raise (or restore from tray-hide) the main window. Used by the
/// single-instance callback and the tray icon.
fn show_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// System tray: left click raises the window, right click opens the menu
/// (Open Console / Close-to-tray toggle / Quit). Quit goes through
/// app.exit(0), which still runs the gateway cleanup in RunEvent::Exit.
fn build_tray(app: &tauri::App, close_to_tray: bool) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Console", true, None::<&str>)?;
    let hide_on_close = CheckMenuItem::with_id(
        app,
        "close_to_tray",
        "Close to tray (keep gateway running)",
        true,
        close_to_tray,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &hide_on_close, &quit])?;
    let state = app.state::<GatewayState>();
    *state.close_to_tray_item.lock().unwrap() = Some(hide_on_close.clone());
    TrayIconBuilder::with_id("main-tray")
        .icon(
            app.default_window_icon()
                .expect("bundle provides a window icon")
                .clone(),
        )
        .tooltip("OmniCellRouter")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "close_to_tray" => {
                // CheckMenuItem toggles itself visually on click; sync our
                // persisted flag with the new visual state.
                let state = app.state::<GatewayState>();
                let enabled = state
                    .close_to_tray_item
                    .lock()
                    .unwrap()
                    .as_ref()
                    .and_then(|item| item.is_checked().ok())
                    .unwrap_or_else(|| !state.close_to_tray.load(Ordering::Relaxed));
                state.close_to_tray.store(enabled, Ordering::Relaxed);
                let home = default_ocr_home(
                    &app.path()
                        .resource_dir()
                        .unwrap_or(std::env::temp_dir().into()),
                );
                save_close_to_tray(&home, enabled);
                shell_log(&home, &format!("close_to_tray = {enabled}"));
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Best-effort append-only shell trace: <OCR_HOME>/desktop.log. The gateway's
/// own output lives in gateway.log; this file records the SHELL's decisions
/// (spawn failures, health waits, window creation) so a silent-looking GUI
/// failure always has a paper trail.
fn shell_log(home: &std::path::Path, msg: &str) {
    let line = format!("[{}] {msg}\n", unix_now());
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(home.join("desktop.log"))
    {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Same data root `ocr desktop` / the daemon tooling already assume
/// (%LOCALAPPDATA%\omnicell-router).
#[cfg(windows)]
fn default_ocr_home(resource_dir: &std::path::Path) -> std::path::PathBuf {
    std::env::var("LOCALAPPDATA")
        .map(|d| std::path::PathBuf::from(d).join("omnicell-router"))
        .unwrap_or_else(|_| resource_dir.join("data"))
}

/// GUI parents (Explorer shortcut, macOS Finder/LaunchServices) freeze PATH
/// at logon — tools added later (the opencode CLI among them) stay
/// unresolvable for the whole desktop chain, which degrades the credential
/// store to read-only. Merge the platform's canonical user tool dirs into
/// the inherited PATH so the sidecar sees what a fresh terminal would.
fn sidecar_path_env() -> String {
    let sep = if cfg!(windows) { ';' } else { ':' };
    let inherited = std::env::var("PATH").unwrap_or_default();
    let mut parts: Vec<String> = inherited
        .split(sep)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let mut push = |parts: &mut Vec<String>, entry: &str| {
        let entry = entry.trim().to_string();
        if !entry.is_empty() && !parts.iter().any(|e| e.eq_ignore_ascii_case(&entry)) {
            parts.push(entry);
        }
    };
    #[cfg(windows)]
    if let Some(user) = registry_user_path() {
        for entry in user.split(';') {
            push(&mut parts, entry);
        }
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        if !home.is_empty() {
            for entry in [
                format!("{home}/.local/bin"),
                "/opt/homebrew/bin".to_string(),
                "/usr/local/bin".to_string(),
                format!("{home}/.bun/bin"),
                format!("{home}/.cargo/bin"),
            ] {
                push(&mut parts, &entry);
            }
        }
    }
    parts.join(if cfg!(windows) { ";" } else { ":" })
}

#[cfg(windows)]
fn registry_user_path() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let env = hkcu.open_subkey("Environment").ok()?;
    env.get_value("PATH").ok()
}

/// POSIX: %LOCALAPPDATA% doesn't exist and bundling the data dir under the
/// install location fails (AppImage squashfs is read-only, deb lands under
/// /usr, macOS translocation mounts unsigned apps read-only). Use the
/// platform data dir instead; a `data/` folder next to the binary is the
/// dev-run fallback only.
#[cfg(not(windows))]
fn default_ocr_home(resource_dir: &std::path::Path) -> std::path::PathBuf {
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        if !xdg.trim().is_empty() {
            return std::path::PathBuf::from(xdg).join("omnicell-router");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            if cfg!(target_os = "macos") {
                return std::path::PathBuf::from(home).join("Library/Application Support/omnicell-router");
            }
            return std::path::PathBuf::from(home).join(".local/share/omnicell-router");
        }
    }
    resource_dir.join("data")
}

/// Spawn the gateway (or adopt a healthy one), wait for readiness, open the
/// window. Every failure returns a user-readable message; setup turns it into
/// a native dialog + desktop.log trace + deterministic exit(1) — a GUI binary
/// that dies from a setup error is otherwise completely silent.
fn boot(app: &tauri::App) -> Result<(), String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("cannot resolve resource dir: {e}"))?;
    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("cannot resolve app dir: {e}"))?
        .parent()
        .expect("exe has a parent dir")
        .to_path_buf();
    let sidecar = exe_dir.join(SIDECAR_FILE);
    let home = default_ocr_home(&resource_dir);

    // First-run default = 75% of the primary monitor (logical), clamped to a
    // usable minimum. After the first session the SAVED bounds take over
    // (remember-my-geometry), so this only shapes the first impression.
    let (mut default_w, mut default_h) = (1320.0f64, 880.0f64);
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        default_w = (monitor.size().width as f64 / scale * 0.75).round().max(1024.0);
        default_h = (monitor.size().height as f64 / scale * 0.75).round().max(680.0);
    }

    if !health_ok(PORT) {
        if !sidecar.exists() {
            return Err(format!(
                "gateway program not found:\n  {}\n\nReinstall the application — this file ships inside the installer.",
                sidecar.display()
            ));
        }
        fs::create_dir_all(&home)
            .map_err(|e| format!("cannot create data folder {}:\n{e}", home.display()))?;
        shell_log(&home, &format!("spawning sidecar {}", sidecar.display()));
        // CREATE_NO_WINDOW keeps the console-subsystem sidecar from opening
        // its own console host; its output lands in <home>/gateway.log.
        let mut cmd = Command::new(&sidecar);
        // cwd = resource dir so the gateway's frontend/dist candidate
        // (`cwd/frontend/dist`) resolves to the bundled console assets.
        cmd.current_dir(&resource_dir)
            .env("OCR_HOME", &home)
            .env("PORT", PORT.to_string())
            .env("HOST", "127.0.0.1");
        // GUI-parented chains freeze PATH at logon; merge the platform's
        // canonical tool dirs so the opencode CLI resolves (credential-store
        // write capability depends on it).
        cmd.env("PATH", sidecar_path_env());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(home.join("gateway.log"))
            .map_err(|e| format!("cannot open gateway.log:\n{e}"))?;
        cmd.stdout(Stdio::from(
            log.try_clone().map_err(|e| e.to_string())?,
        ))
        .stderr(Stdio::from(log));
        let child = cmd
            .spawn()
            .map_err(|e| format!("failed to start the gateway program:\n{}\n\n{e}", sidecar.display()))?;
        shell_log(&home, &format!("sidecar spawned pid={}", child.id()));
        let state = app.state::<GatewayState>();
        *state.child.lock().unwrap() = Some(child);
        *state.home.lock().unwrap() = Some(home.clone());
    }

    // Visible IMMEDIATELY with the bundled loading page — gateway boot takes
    // 10-30s (catalog sync, Defender scans) and a black wait reads as a hang.
    // Once /health answers, the SAME window navigates onto the console.
    // NOTE: not WebviewWindowBuilder::center() — that centers on the WORK
    // AREA (excluding the taskbar); we center on the full monitor below.
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("OmniCellRouter")
        .inner_size(default_w, default_h)
        .build()
        .map_err(|e| format!("failed to open the app window:\n{e}"))?;
    let win = app.get_webview_window("main").expect("main window exists");
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let monitor_size = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| *m.size());
    let req_w = (default_w * scale).round() as i64;
    let req_h = (default_h * scale).round() as i64;
    let saved = load_window_bounds(&home);
    let win2 = win.clone();
    std::thread::spawn(move || {
        // WebView2 settles the frame asynchronously — measuring earlier
        // returns stale sizes (raced corrections were swallowed).
        std::thread::sleep(Duration::from_millis(400));
        // Chrome delta: settled outer minus the client we requested at
        // build time (physical). Constant for this window's style, so the
        // saved outer bounds convert exactly: client = saved_outer - delta.
        let (delta_w, delta_h) = win2
            .outer_size()
            .map(|o| (o.width as i64 - req_w, o.height as i64 - req_h))
            .unwrap_or((0, 0));
        match saved {
            Some((x, y, wo, ho)) => {
                let _ = win2.set_size(tauri::PhysicalSize::new(
                    (wo as i64 - delta_w).max(400) as u32,
                    (ho as i64 - delta_h).max(300) as u32,
                ));
                let _ = win2.set_position(tauri::PhysicalPosition::new(x, y));
            }
            None => {
                if let Some(mon) = monitor_size {
                    if let Ok(o) = win2.outer_size() {
                        let x = ((mon.width as i64 - o.width as i64) / 2).max(0) as i32;
                        let y = ((mon.height as i64 - o.height as i64) / 2).max(0) as i32;
                        let _ = win2.set_position(tauri::PhysicalPosition::new(x, y));
                    }
                }
            }
        }
    });

    if !wait_health(PORT, HEALTH_TIMEOUT) {
        return Err(format!(
            "the gateway did not become healthy on 127.0.0.1:{PORT} within {}s.\n\nIts output is in:\n  {}",
            HEALTH_TIMEOUT.as_secs(),
            home.join("gateway.log").display()
        ));
    }
    shell_log(&home, "gateway healthy");

    // Navigate the SAME window onto the console — no second window, no
    // flicker: the loading page IS the boot UX.
    let url = format!("http://127.0.0.1:{PORT}/admin/");
    let _ = win.eval(&format!("window.location.replace('{url}')"));
    let _ = win.set_focus();
    shell_log(&home, "window created");
    Ok(())
}

fn main() {
    tauri::Builder::default()
        // MUST be the first plugin: a second app launch exits immediately and
        // this callback focuses the existing window instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(GatewayState {
            child: Mutex::new(None),
            home: Mutex::new(None),
            close_to_tray: AtomicBool::new(false),
            close_to_tray_item: Mutex::new(None),
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Remember geometry on BOTH close paths (exit and tray-hide).
                let handle = window.app_handle();
                let home = default_ocr_home(
                    &handle
                        .path()
                        .resource_dir()
                        .unwrap_or(std::env::temp_dir().into()),
                );
                persist_window_bounds(&home, window);
                // Default desktop contract: X exits (gateway cleanup runs in
                // RunEvent::Exit). Tray residency is opt-in via the tray
                // checkbox — then close hides and only Quit really exits.
                let to_tray = handle
                    .state::<GatewayState>()
                    .close_to_tray
                    .load(Ordering::Relaxed);
                if to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(move |app| {
            // Load the close-to-tray preference BEFORE the window exists so
            // the first CloseRequested already honors it.
            let ocr_home = default_ocr_home(
                &app.path()
                    .resource_dir()
                    .unwrap_or(std::env::temp_dir().into()),
            );
            let close_to_tray = load_close_to_tray(&ocr_home);
            app.state::<GatewayState>()
                .close_to_tray
                .store(close_to_tray, Ordering::Relaxed);
            if let Err(msg) = boot(app) {
                // A GUI binary failing in setup dies SILENTLY (no console, no
                // window): leave a persistent trace, show a native dialog with
                // the reason + log path, then exit. Cleanup is EXPLICIT here —
                // boot() may have already spawned the sidecar (health-timeout
                // path), and std::process::exit would skip RunEvent::Exit and
                // orphan it as a headless gateway holding the port.
                let state = app.state::<GatewayState>();
                if let Some(mut child) = state.child.lock().unwrap().take() {
                    let _ = child.kill();
                }
                let home = state.home.lock().unwrap().take();
                let log_home = home
                    .clone()
                    .unwrap_or_else(|| default_ocr_home(&std::env::temp_dir()));
                let _ = fs::create_dir_all(&log_home);
                shell_log(&log_home, &format!("boot failed: {msg}"));
                app.dialog()
                    .message(format!(
                        "OmniCellRouter failed to start:\n\n{msg}\n\nShell log: {}",
                        log_home.join("desktop.log").display()
                    ))
                    .title("OmniCellRouter")
                    .blocking_show();
                if let Some(home) = home {
                    kill_gateway_tree(&home);
                }
                app.handle().exit(1);
                return Ok(());
            }
            build_tray(app, close_to_tray)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                let state = app_handle.state::<GatewayState>();
                if let Some(mut child) = state.child.lock().unwrap().take() {
                    let _ = child.kill();
                }
                let home = state.home.lock().unwrap().take();
                if let Some(home) = home {
                    kill_gateway_tree(&home);
                }
            }
        });
}
