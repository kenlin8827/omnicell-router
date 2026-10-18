// Prevents an extra console window on Windows in release builds (the shell
// itself is a GUI binary; keep the console in dev for logs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// OpenCode Router desktop shell (Tauri v2).
//
// Lifecycle: (optionally) spawn the gateway sidecar next to this binary,
// wait for its /health, then open a window on the console UI the gateway
// serves at http://127.0.0.1:<port>/admin/. The sidecar is killed on exit.
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
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;

const PORT: u16 = 4000;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);

/// Windows: spawn the console-subsystem sidecar WITHOUT a console host window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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

#[cfg(not(windows))]
fn kill_gateway_tree(_home: &std::path::Path) {}

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
/// (Open Console / Quit). Quit goes through app.exit(0), which still runs the
/// gateway cleanup in the RunEvent::Exit handler.
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Console", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    TrayIconBuilder::with_id("main-tray")
        .icon(
            app.default_window_icon()
                .expect("bundle provides a window icon")
                .clone(),
        )
        .tooltip("OpenCode Router")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
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
/// (%LOCALAPPDATA%\opencode-router).
fn default_ocr_home(resource_dir: &std::path::Path) -> std::path::PathBuf {
    std::env::var("LOCALAPPDATA")
        .map(|d| std::path::PathBuf::from(d).join("opencode-router"))
        .unwrap_or_else(|_| resource_dir.join("data"))
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
    let sidecar = exe_dir.join("ocr-backend.exe");
    let home = default_ocr_home(&resource_dir);

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

    if !wait_health(PORT, HEALTH_TIMEOUT) {
        return Err(format!(
            "the gateway did not become healthy on 127.0.0.1:{PORT} within {}s.\n\nIts output is in:\n  {}",
            HEALTH_TIMEOUT.as_secs(),
            home.join("gateway.log").display()
        ));
    }
    shell_log(&home, "gateway healthy");

    let url = format!("http://127.0.0.1:{PORT}/admin/")
        .parse::<tauri::Url>()
        .map_err(|e| e.to_string())?;
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("OpenCode Router")
        .inner_size(1320.0, 880.0)
        .build()
        .map_err(|e| format!("failed to open the app window:\n{e}"))?;
    // Note: NOT WebviewWindowBuilder::center() — that centers on the WORK
    // AREA (excluding the taskbar), which reads as off-center. Reposition
    // onto the full primary monitor in physical pixels for true centering.
    if let Ok(Some(monitor)) = app.primary_monitor() {
        if let Some(win) = app.get_webview_window("main") {
            let monitor_size = monitor.size();
            if let Ok(window_size) = win.outer_size() {
                let x = (monitor_size.width as f64 - window_size.width as f64) / 2.0;
                let y = (monitor_size.height as f64 - window_size.height as f64) / 2.0;
                let _ = win.set_position(tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32));
            }
        }
    }
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
        })
        .on_window_event(|window, event| {
            // Close = hide to tray; the gateway keeps serving in the
            // background. Real exit is tray → Quit, which runs the gateway
            // cleanup in the RunEvent::Exit handler.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(move |app| {
            if let Err(msg) = boot(app) {
                // A GUI binary failing in setup dies SILENTLY (no console, no
                // window): leave a persistent trace, show a native dialog with
                // the reason + log path, then exit deterministically.
                let home = default_ocr_home(&std::env::temp_dir());
                let _ = fs::create_dir_all(&home);
                shell_log(&home, &format!("boot failed: {msg}"));
                app.dialog()
                    .message(format!(
                        "OpenCode Router failed to start:\n\n{msg}\n\nShell log: {}",
                        home.join("desktop.log").display()
                    ))
                    .title("OpenCode Router")
                    .blocking_show();
                std::process::exit(1);
            }
            build_tray(app)?;
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
