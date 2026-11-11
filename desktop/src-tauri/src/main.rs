// Prevents an extra console window on Windows in release builds (the shell
// itself is a GUI binary; keep the console in dev for logs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// OmniCellRouter desktop shell (Tauri v2).
//
// Lifecycle: (optionally) spawn the gateway sidecar next to this binary,
// wait for its /health, then open a window on the console UI the gateway
// serves at http://127.0.0.1:<port>/admin/. The sidecar is killed on exit.
// Recovery: once the console is up the shell keeps polling /health. A gateway
// restart / environment switch takes the console's own origin down, so the
// shell swaps the webview to the boot splash, follows the gateway to its
// (possibly new) port when health returns, and reports the last handover
// verdict natively when it never comes back (ocr.restart.json + log path).
//
// Window close follows the STANDARD desktop contract — X exits the app and
// stops the gateway. Tray residency is OPT-IN via the tray menu checkbox
// "Close to tray" (persisted in <OCR_HOME>/desktop.json); when enabled, X
// hides the window and only the tray Quit really exits.
//
// Startup: the opt-in tray checkbox "Start with system" registers the shell
// with the OS (Windows Run key / macOS LaunchAgent / Linux XDG autostart).
// The registered command line carries `--autostart`, so a login launch boots
// the gateway and parks in the tray instead of popping the console window.
// The OS registration is the single source of truth — no desktop.json twin.
//
// The gateway binary is produced by `bun run sidecar` (bun build --compile
// of backend/src/index.ts) and declared as Tauri externalBin "bin/ocr-backend"
// — Tauri copies it next to the app binary at build time, so both the
// installed layout and target/release lookups share the same parent dir.

mod i18n;

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
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

const PORT: u16 = 4000;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);

/// Login-launch marker baked into the autostart entry (Windows Run value /
/// macOS LaunchAgent / Linux .desktop Exec). A normal launch (Start menu,
/// shortcut, installer hook) carries no argument and shows the console.
const AUTOSTART_ARG: &str = "--autostart";

fn is_autostart_launch() -> bool {
    std::env::args().any(|a| a == AUTOSTART_ARG)
}

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

/// Desktop recovery cadence. The console is a REMOTE page served BY the
/// gateway: a gateway restart / environment switch takes the whole UI down,
/// and the page cannot ask the shell for help (Tauri IPC is not injected into
/// the sidecar's HTTP origin). The SHELL therefore owns the down/up
/// transitions — show the offline splash, follow the gateway to its (possibly
/// new) port on recovery, and surface a failed handover natively.
const MONITOR_POLL: Duration = Duration::from_secs(1);
const MONITOR_SPLASH: Duration = Duration::from_secs(2);
const MONITOR_FAIL: Duration = Duration::from_secs(45);

/// Port the gateway is actually serving on, per `<home>/ocr.info.json`.
/// Written by the CLI / restart supervisor and by a restarted gateway; a
/// desktop-spawned sidecar has no record until its first handover, so the
/// caller keeps the port it already loaded.
fn read_gateway_port(home: &std::path::Path) -> Option<u16> {
    let raw = fs::read_to_string(home.join("ocr.info.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    u16::try_from(v.get("port")?.as_u64()?).ok()
}

/// Verdict of the last controlled startup/restart (backend/src/cli/daemon.ts
/// `RestartStatus`).
struct RestartVerdict {
    status: String,
    error: Option<String>,
    log: Option<String>,
}

fn read_restart_verdict(home: &std::path::Path) -> Option<RestartVerdict> {
    let raw = fs::read_to_string(home.join("ocr.restart.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some(RestartVerdict {
        status: v.get("status")?.as_str()?.to_string(),
        error: v.get("error").and_then(|e| e.as_str()).map(str::to_string),
        log: v.get("logFile").and_then(|e| e.as_str()).map(str::to_string),
    })
}

/// A verdict written BEFORE this monitor session belongs to a previous run:
/// a plain crash now must not resurrect an old handover error. Filesystems
/// with coarse mtime granularity get a 2 s slack.
fn verdict_is_fresh(home: &std::path::Path, since: SystemTime) -> bool {
    fs::metadata(home.join("ocr.restart.json"))
        .and_then(|m| m.modified())
        .map(|m| m + Duration::from_secs(2) >= since)
        .unwrap_or(false)
}

/// Worker thread started once the console is up (see `boot`).
fn watch_gateway(app: tauri::AppHandle, home: std::path::PathBuf, splash: Option<tauri::Url>) {
    let mut loaded_port = PORT;
    let session_start = SystemTime::now();
    let mut down_since: Option<Instant> = None;
    let mut on_splash = false;
    // Console route in flight when the origin died. Recovery re-enters there
    // instead of dumping the operator on the admin home after every blip.
    let mut last_path: Option<String> = None;
    // Last verdict surfaced, not a bool: the supervisor's crash-retry path
    // writes `failed` only after its attempts time out, and a `reported`
    // latch set on the generic 45 s notice would swallow that explanation.
    let mut reported: Option<String> = None;

    loop {
        std::thread::sleep(MONITOR_POLL);
        // The recorded port is a HINT, never authoritative: this shell always
        // spawns its gateway on PORT, and `ocr.info.json` may still describe a
        // handover from a previous session (environment switch to a different
        // port, then a desktop relaunch). Adopting it blindly makes the shell
        // poll a dead port and swap a perfectly healthy console for the
        // splash. Only a recorded port that actually ANSWERS wins.
        let mut port = loaded_port;
        let mut up = health_ok(port);
        if !up {
            if let Some(recorded) = read_gateway_port(&home) {
                if recorded != port && health_ok(recorded) {
                    port = recorded;
                    up = true;
                }
            }
        }
        // A closed window (no tray residency) leaves nothing to navigate.
        let Some(win) = app.get_webview_window("main") else {
            continue;
        };

        if up {
            let was_down = down_since.is_some();
            down_since = None;
            reported = None;
            if was_down || on_splash || port != loaded_port {
                let path = last_path.take().unwrap_or_else(|| "/admin/".to_string());
                if let Ok(url) = tauri::Url::parse(&format!("http://127.0.0.1:{port}{path}")) {
                    let _ = win.navigate(url);
                    loaded_port = port;
                    on_splash = false;
                }
            }
            continue;
        }

        let since = *down_since.get_or_insert_with(Instant::now);
        // A dead origin cannot render anything useful: swap in the offline
        // splash at once, then come back to the console when health returns.
        if !on_splash && since.elapsed() >= MONITOR_SPLASH {
            last_path = win
                .url()
                .ok()
                .map(|u| u.path().to_string())
                .filter(|p| p.starts_with('/'));
            if let Some(url) = splash.clone() {
                let _ = win.navigate(url);
            }
            on_splash = true;
        }
        // A `failed` verdict is final and explains itself; without one, a long
        // outage still needs a native notice (a crashed gateway writes nothing).
        let fresh = verdict_is_fresh(&home, session_start);
        let verdict = if fresh { read_restart_verdict(&home) } else { None };
        let failed = verdict.as_ref().is_some_and(|v| v.status == "failed");
        // Re-report when the verdict advances from "no verdict yet" to
        // `failed`; a plain outage still reports exactly once.
        let key = if failed { Some("failed".to_string()) } else { None };
        let due = since.elapsed() >= MONITOR_FAIL;
        if key != reported && (failed || due) {
            reported = key;
            show_gateway_down(&app, &home, verdict.as_ref());
        }
    }
}

fn show_gateway_down(
    app: &tauri::AppHandle,
    home: &std::path::Path,
    verdict: Option<&RestartVerdict>,
) {
    let l = i18n::labels();
    let log = verdict.and_then(|v| v.log.clone()).unwrap_or_else(|| {
        let supervised = home.join("ocr.log");
        (if supervised.exists() {
            supervised
        } else {
            home.join("gateway.log")
        })
        .display()
        .to_string()
    });
    let mut body = l.gateway_down_body.to_string();
    if let Some(err) = verdict.and_then(|v| v.error.as_deref()) {
        body.push_str("\n\n");
        body.push_str(err);
    }
    body.push_str(&format!(
        "\n\n{}: {}\n\n{}",
        l.gateway_down_log, log, l.gateway_down_retry
    ));
    app.dialog()
        .message(body)
        .title(l.gateway_down_title)
        .buttons(MessageDialogButtons::Ok)
        .show(|_| {});
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
    /// State of the OS autostart registration, mirrored for quick reads.
    /// The OS entry itself is authoritative; this is refreshed at boot and
    /// on every toggle.
    start_with_system: AtomicBool,
    /// Tray checkbox for the above; a failed enable/disable reverts it so
    /// the menu never claims a registration the OS refused.
    start_with_system_item: Mutex<Option<tauri::menu::CheckMenuItem<tauri::Wry>>>,
    /// The one tray item that is NOT a checkbox: install-or-uninstall the
    /// `ocr` command. It toggles, so its label is rewritten after every
    /// action — the item must never offer a verb that does not apply.
    cli_command_item: Mutex<Option<MenuItem<tauri::Wry>>>,
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

/// Merge ONE shell preference into desktop.json. Read-modify-write keeps the
/// other keys (window bounds, closeToTray) intact — a whole-file write would
/// silently drop whichever writer ran last.
/// Serialises the read-modify-write of `desktop.json`. Two writers now exist
/// on different threads (window bounds on the main thread, `cliShims` from the
/// spawned registration thread): without the lock one can read `{}` mid-write
/// and drop the other's key.
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

fn save_setting(home: &std::path::Path, key: &str, value: serde_json::Value) {
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut v: serde_json::Value = fs::read_to_string(settings_path(home))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    v[key] = value;
    let _ = fs::create_dir_all(home);
    // Temp + rename: a crash mid-write must never leave a truncated file that
    // the next launch reads as `{}` (the lock alone does not survive a kill).
    let path = settings_path(home);
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, serde_json::to_string(&v).unwrap_or_default()).is_ok() {
        let _ = fs::rename(&tmp, &path);
    }
}

fn save_close_to_tray(home: &std::path::Path, enabled: bool) {
    save_setting(home, "closeToTray", serde_json::Value::Bool(enabled));
}

/// Whether the first-run "start with system" question has been ANSWERED.
/// Deliberately not a mirror of the current state: the OS registration (Run
/// key / LaunchAgent / XDG file) stays authoritative for that, so this only
/// stops the offer from nagging after a yes or a no.
fn autostart_asked(home: &std::path::Path) -> bool {
    fs::read_to_string(settings_path(home))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("autostartPrompt").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

/// Register (or unregister) the login launch and mirror the result into the
/// shell: the tray checkbox, the in-memory flag and — for an enable — the
/// implied close-to-tray preference. ONE path for both callers (tray item /
/// first-run offer) so the implied flip cannot drift between them.
fn set_autostart(
    app: &tauri::AppHandle,
    enabled: bool,
    home: &std::path::Path,
) -> Result<(), String> {
    let result = if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    result.map_err(|err| err.to_string())?;
    let state = app.state::<GatewayState>();
    state.start_with_system.store(enabled, Ordering::Relaxed);
    {
        let item = state.start_with_system_item.lock().unwrap();
        if let Some(item) = item.as_ref() {
            let _ = item.set_checked(enabled);
        }
    }
    // A login launch exists to keep the gateway running; with tray residency
    // off, the first window close would kill it and defeat the whole point.
    // Flip the sibling checkbox (visible, persisted) — the operator can still
    // turn it back off afterwards.
    if enabled && !state.close_to_tray.load(Ordering::Relaxed) {
        state.close_to_tray.store(true, Ordering::Relaxed);
        {
            let item = state.close_to_tray_item.lock().unwrap();
            if let Some(item) = item.as_ref() {
                let _ = item.set_checked(true);
            }
        }
        save_close_to_tray(home, true);
        shell_log(home, "close_to_tray = true (implied by start_with_system)");
    }
    Ok(())
}

/// Was the first-run CLI question ANSWERED: `Some(true)` = the operator said
/// yes, `Some(false)` = declined, `None` = never asked.
///
/// Deliberately NOT "are the commands installed" — that is the marker-checked
/// shim files on disk (`ocr shims-status`), which the tray toggle reads. This
/// key only stops the offer from nagging again; after a tray uninstall it still
/// says `true`, and that is correct: the question was answered.
fn cli_shim_choice(home: &std::path::Path) -> Option<bool> {
    fs::read_to_string(settings_path(home))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("cliShims").and_then(|b| b.as_bool()))
}

/// One `ocr-backend --cli <action>` invocation, wired the same way for every
/// shim action. No console of its own, so all three streams are silent; the
/// outcome is the exit status.
fn sidecar_cli(
    home: &std::path::Path,
    sidecar: &std::path::Path,
    action: &str,
) -> Command {
    let mut cmd = Command::new(sidecar);
    cmd.arg("--cli")
        .arg(action)
        // Pin the app's data root INTO the shim: the shell runs the gateway
        // under its own OCR_HOME (Windows `%LOCALAPPDATA%\omnicell-router`)
        // while the CLI default is `~/.omnicell-router`. Without this the
        // installed `ocr` reads a different book-set than the app and cannot
        // even see the gateway it is meant to control.
        .env("OCR_HOME", home)
        .env("PATH", sidecar_path_env())
        // The shell has no console of its own; keep the registration silent.
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// The tray toggle's state, and the uninstall action, both answered by the
/// packaged binary itself (`ocr shims-status` / `ocr uninstall-shims`).
///
/// Deliberate: the shell must NOT re-derive the shim bin dir or the shim
/// markers — that path literal lives in `backend/src/cli/paths.ts`, and a
/// second copy here would silently report on the wrong directory the day it
/// moves. For `shims-status` the exit code IS the answer (0 = installed); any
/// failure to run it reads as "not installed", which is the safe verb: the
/// menu then offers install, which is idempotent and repairs a broken shim.
fn run_shim_action(home: &std::path::Path, sidecar: &std::path::Path, action: &str) -> bool {
    match sidecar_cli(home, sidecar, action).status() {
        Ok(status) => status.success(),
        Err(err) => {
            shell_log(home, &format!("cli {action} failed to run: {err}"));
            false
        }
    }
}

/// Register the packaged gateway's `--cli` surface as `ocr` / `omnicell-router`.
///
/// The SAME binary serves both the gateway and the command surface: a
/// desktop-only machine has no repo checkout (and no bun/node) for the
/// trampoline variant. Best-effort — a locked-down PATH leaves the gateway
/// working and the preference unset, so the tray entry can retry.
fn install_cli_shims(home: &std::path::Path, sidecar: &std::path::Path) -> bool {
    // AppImage executes from a temporary squashfs mount: a shim pointing inside
    // it dies with the mount, so skip rather than register a broken command.
    if std::env::var_os("APPIMAGE").is_some() {
        shell_log(home, "cli shims skipped: AppImage mount path is transient");
        // Record the answer as a decline: nothing can be registered from a
        // transient squashfs mount, and re-asking on every visible launch would
        // never succeed. The tray entry stays as the manual retry.
        save_setting(home, "cliShims", serde_json::Value::Bool(false));
        return false;
    }
    // The ONE action that also records the first-run ANSWER (`cliShims`): the
    // dialog must not nag again, while the tray toggle stays the retry/repair
    // path and reads its verb from the shims on disk.
    match sidecar_cli(home, sidecar, "install-shims").status() {
        Ok(status) if status.success() => {
            save_setting(home, "cliShims", serde_json::Value::Bool(true));
            shell_log(home, "cli shims registered");
            true
        }
        Ok(status) => {
            shell_log(home, &format!("cli shim registration exited {status}"));
            false
        }
        Err(err) => {
            shell_log(home, &format!("cli shim registration failed: {err}"));
            false
        }
    }
}

/// Parse the wizard's hand-off file: `autostart=<0|1>` and `cliShims=<0|1>`,
/// one per line (see `OcrOptionsLeave` in `nsis/installer.nsi`). `None` means
/// the page never ran, so the in-app prompt still owns that question.
fn installer_choice_answers(text: &str) -> (Option<bool>, Option<bool>) {
    let answer = |key: &str| {
        text.lines().find_map(|line| {
            let (k, v) = line.split_once('=')?;
            (k.trim() == key).then(|| matches!(v.trim(), "1" | "true"))
        })
    };
    (answer("cliShims"), answer("autostart"))
}

/// Fold the NSIS wizard's answers (`installer-choice.ini` in OCR_HOME, written
/// by the "Startup options" page of `nsis/installer.nsi`) into the SAME
/// settings the in-app prompts read, so a wizard-answered install asks nothing.
///
/// Consume-once comes from those settings, not from the file: a stale file (the
/// remove failed, or a relaunch before the write landed) cannot replay an
/// answer the operator has since changed in the tray.
fn consume_installer_choice(
    app: &tauri::AppHandle,
    home: &std::path::Path,
    sidecar: &std::path::Path,
) {
    let path = home.join("installer-choice.ini");
    let Ok(text) = fs::read_to_string(&path) else {
        return;
    };
    let (cli, autostart) = installer_choice_answers(&text);
    if let Some(cli) = cli {
        save_setting(home, "cliShims", serde_json::Value::Bool(cli));
        if cli {
            // Same reason as the dialog path: registration shells out to the
            // bundled gateway, so it must not block the event-loop thread.
            let (home, sidecar) = (home.to_path_buf(), sidecar.to_path_buf());
            let handle = app.clone();
            std::thread::spawn(move || {
                // The tray toggle is labelled from the shims on disk, so a
                // first-run/installer install must flip it NOW — the tray was
                // built (with "install") before this answer arrived.
                if install_cli_shims(&home, &sidecar) {
                    refresh_cli_command_item(&handle, true);
                }
            });
        }
        shell_log(home, &format!("installer choice: cli shims = {cli}"));
    }
    if let Some(autostart) = autostart {
        // The wizard's answer IS the answer: a checked box enables the login
        // launch, an unchecked one records the decline so nothing asks again.
        save_setting(home, "autostartPrompt", serde_json::Value::Bool(true));
        if autostart {
            match set_autostart(app, true, home) {
                Ok(()) => shell_log(home, "installer choice: start_with_system = true"),
                Err(err) => shell_log(
                    home,
                    &format!("start_with_system = true failed: {err}"),
                ),
            }
        }
        shell_log(home, &format!("installer choice: start_with_system = {autostart}"));
    }
    let _ = fs::remove_file(&path);
}

/// First-run offers, asked ONCE each on a VISIBLE launch. Both are opt-in OS
/// registrations (`ocr` command on PATH, login launch), both remember the
/// answer, and both are chained into ONE sequence: the second question is
/// asked when the first dialog closes, so two modals never stack and neither
/// question is starved by the other (an unanswered/failed first question must
/// not suppress the second).
///
/// A Windows install answered both in the wizard already
/// (`consume_installer_choice`): then the settings exist and nothing is asked.
/// The dialogs remain the fallback for every path with no wizard — macOS dmg,
/// Linux AppImage/deb, silent `/S` and passive `/P` installs, and upgrades
/// from a build that predates the wizard page.
///
/// A login (autostart) launch never prompts — a hidden tray start must not
/// block on a modal dialog; the questions wait for the next visible launch.
///
/// Uses the ASYNC `show`, not `blocking_show`: setup owns the main thread and
/// the plugin dispatches dialogs through the event loop, so blocking here would
/// deadlock startup (documented by the plugin itself). The response callback
/// runs on a worker thread, which is why the follow-up dialog is shown from a
/// cloned `AppHandle` (its own `show` re-dispatches to the main thread).
fn offer_first_run_choices(
    app: &tauri::App,
    home: &std::path::Path,
    sidecar: &std::path::Path,
    allow_prompt: bool,
) {
    if !allow_prompt {
        return;
    }
    consume_installer_choice(app.handle(), home, sidecar);
    if cli_shim_choice(home).is_some() {
        offer_autostart(app.handle(), home);
        return;
    }
    let labels = i18n::labels();
    let home = home.to_path_buf();
    let sidecar = sidecar.to_path_buf();
    let handle = app.handle().clone();
    app.dialog()
        .message(labels.cli_prompt_message)
        .title(labels.cli_prompt_title)
        .buttons(MessageDialogButtons::YesNo)
        .show(move |accepted| {
            if accepted {
                // Registration shells out to the bundled gateway (blocking
                // `status()`): keep it off the event-loop thread so the window
                // never freezes while the shim is written.
                let (home, sidecar) = (home.clone(), sidecar.clone());
                let tray = handle.clone();
                std::thread::spawn(move || {
                    // Flip the tray toggle to "remove": it was labelled
                    // "install" when the menu was built, before this answer.
                    if install_cli_shims(&home, &sidecar) {
                        refresh_cli_command_item(&tray, true);
                    }
                });
            } else {
                // Persist the DECLINE so the dialog never nags; the tray entry
                // stays available for a later change of mind.
                save_setting(&home, "cliShims", serde_json::Value::Bool(false));
                shell_log(&home, "cli shims declined by operator");
            }
            offer_autostart(&handle, &home);
        });
}

/// Second first-run question: should the shell register itself for OS login
/// launch? Asked only when the install path had no wizard page to answer it.
fn offer_autostart(app: &tauri::AppHandle, home: &std::path::Path) {
    if autostart_asked(home) {
        return;
    }
    // Already registered — the tray toggle of an earlier session, or an entry
    // the operator made by hand. Nothing to ask, just stop offering.
    if app.autolaunch().is_enabled().unwrap_or(false) {
        save_setting(home, "autostartPrompt", serde_json::Value::Bool(true));
        return;
    }
    let labels = i18n::labels();
    let home = home.to_path_buf();
    let handle = app.clone();
    app.dialog()
        .message(labels.autostart_prompt_message)
        .title(labels.autostart_prompt_title)
        .buttons(MessageDialogButtons::YesNo)
        .show(move |accepted| {
            // Answering either way settles the question: the tray checkbox is
            // the way back in, so this prompt must not reappear.
            save_setting(&home, "autostartPrompt", serde_json::Value::Bool(true));
            if accepted {
                match set_autostart(&handle, true, &home) {
                    Ok(()) => shell_log(&home, "start_with_system = true"),
                    // Locked-down policy / unwritable registry: the gateway
                    // still works and the tray item stays for a manual retry.
                    Err(err) => shell_log(
                        &home,
                        &format!("start_with_system = true failed: {err}"),
                    ),
                }
            } else {
                shell_log(&home, "start with system declined by operator");
            }
        });
}

/// Persisted geometry contract: the NORMAL (un-maximized) outer bounds plus a
/// `maximized` flag. Persisting the MAXIMIZED rect as the normal size is the
/// classic bug: the next launch reopens a screen-filling "normal" window, and
/// because the maximized state was never recorded the operator can never get
/// the pre-maximize size back. Called from CloseRequested — both the exit path
/// and the tray-hide path.
fn persist_window_bounds(
    home: &std::path::Path,
    win: &tauri::Window,
) {
    // A minimized window reports its off-screen parked rect (Windows parks at
    // -32000); keep the last known geometry instead of poisoning the file.
    if win.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = win.is_maximized().unwrap_or(false);
    // Maximized: the current outer rect IS the maximized rect, so keep the
    // previously saved normal bounds and only record the flag. Not maximized:
    // the current outer rect is the geometry to restore.
    let mut entry = fs::read_to_string(settings_path(home))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("window").cloned())
        .unwrap_or_else(|| serde_json::json!({}));
    if !maximized {
        let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
            return;
        };
        entry["x"] = pos.x.into();
        entry["y"] = pos.y.into();
        entry["w"] = size.width.into();
        entry["h"] = size.height.into();
    }
    entry["maximized"] = maximized.into();
    save_setting(home, "window", entry);
}

/// Saved geometry: the NORMAL bounds (physical, outer) and whether the window
/// was maximized. `bounds` is `None` when no usable rect was persisted (a
/// first-run maximize): the restore path falls back to the 75% default.
#[derive(Clone, Copy)]
struct WindowGeometry {
    bounds: Option<(i32, i32, u32, u32)>,
    maximized: bool,
}

/// Corrupt entries fall back to the first-run default.
///
/// A file without the `maximized` flag predates state persistence and could
/// only have stored a maximized rect as a normal size (the app-always-opens-
/// fullscreen bug), so its bounds are NOT trustworthy: ignore them once and
/// reopen at the 75% default. The next close writes flag-bearing bounds, so
/// this migration happens at most once per install.
fn load_window_geometry(home: &std::path::Path) -> Option<WindowGeometry> {
    let v: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(settings_path(home)).ok()?,
    )
    .ok()?;
    let w = v.get("window")?;
    let Some(maximized) = w.get("maximized").and_then(|b| b.as_bool()) else {
        return Some(WindowGeometry {
            bounds: None,
            maximized: false,
        });
    };
    let bounds = (|| {
        let (x, y) = (w.get("x")?.as_i64()? as i32, w.get("y")?.as_i64()? as i32);
        let (wd, ht) = (w.get("w")?.as_u64()? as u32, w.get("h")?.as_u64()? as u32);
        if wd < 400 || ht < 300 {
            return None;
        }
        Some((x, y, wd, ht))
    })();
    Some(WindowGeometry { bounds, maximized })
}

/// Read a pid-file (trimmed, digits only).
fn read_pid_file(path: &std::path::Path) -> Option<String> {
    let pid = fs::read_to_string(path).ok()?;
    let pid = pid.trim().to_string();
    if pid.is_empty() || !pid.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(pid)
}

/// The gateway may have REPLACED itself via the console restart route — that
/// replacement is a detached grandchild, not our direct child, so
/// `child.kill()` misses it. Kill the pid-file process tree instead so a
/// window close truly stops everything we started.
///
/// A handover in flight ALSO publishes the gateway it spawned
/// (`ocr.restart.child`): the tracked pid may be the restart SUPERVISOR, and
/// `taskkill /F` cannot deliver a cancel signal, so the replacement has to be
/// reaped explicitly (mirrors `reapInFlightGateway` in `backend/src/cli/daemon.ts`).
#[cfg(windows)]
fn kill_gateway_tree(home: &std::path::Path) {
    for file in ["ocr.pid", "ocr.restart.child"] {
        if let Some(pid) = read_pid_file(&home.join(file)) {
            let mut kill = Command::new("taskkill");
            kill.args(["/F", "/T", "/PID", pid.as_str()])
                .creation_flags(CREATE_NO_WINDOW);
            let _ = kill.output();
        }
    }
    let _ = fs::remove_file(home.join("ocr.restart.child"));
}

/// POSIX: the gateway may have REPLACED itself via the console restart
/// route (detached grandchild, not our direct child) — deliver SIGTERM to
/// the pid-file pid so a window close stops everything we started. The
/// in-flight handover record is reaped the same way (the supervisor's own
/// SIGTERM handler also does it; whoever gets there first wins).
#[cfg(not(windows))]
fn kill_gateway_tree(home: &std::path::Path) {
    for file in ["ocr.pid", "ocr.restart.child"] {
        let Some(pid) = read_pid_file(&home.join(file)) else {
            continue;
        };
        let Ok(pid) = pid.parse::<i32>() else {
            continue;
        };
        // SAFETY: kill(2) with a validated numeric pid; EPERM/ESRCH are ignored
        // (the gateway may already be gone).
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
    }
    let _ = fs::remove_file(home.join("ocr.restart.child"));
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
/// (Open Console / Close-to-tray toggle / Start-with-system toggle /
/// Install-or-Remove OCR command / Quit). Quit goes through app.exit(0),
/// which still runs the gateway cleanup in RunEvent::Exit.
fn build_tray(
    app: &tauri::App,
    close_to_tray: bool,
    start_with_system: bool,
) -> tauri::Result<()> {
    let labels = i18n::labels();
    // Install-or-uninstall is a TOGGLE, so its verb comes from the shims on
    // disk at build time (`ocr shims-status`). One short self-exec (a few
    // hundred ms, measured) before the first paint is the price of never
    // showing a verb that does not apply — a persisted flag would lie the
    // moment the operator deleted a shim by hand, and correcting the label a
    // beat after the icon appears is a visible flicker on every launch.
    let cli_home = app_home(app.handle());
    let cli_sidecar = sidecar_path();
    let cli_installed = cli_sidecar
        .as_deref()
        .map(|sidecar| run_shim_action(&cli_home, sidecar, "shims-status"))
        .unwrap_or(false);
    let open = MenuItem::with_id(app, "open", labels.open, true, None::<&str>)?;
    let hide_on_close = CheckMenuItem::with_id(
        app,
        "close_to_tray",
        labels.close_to_tray,
        true,
        close_to_tray,
        None::<&str>,
    )?;
    let start_at_login = CheckMenuItem::with_id(
        app,
        "start_with_system",
        labels.start_with_system,
        true,
        start_with_system,
        None::<&str>,
    )?;
    let install_cli = MenuItem::with_id(
        app,
        "install_cli",
        if cli_installed {
            labels.cli_uninstall_menu
        } else {
            labels.cli_install_menu
        },
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", labels.quit, true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open, &hide_on_close, &start_at_login, &install_cli, &quit],
    )?;
    let state = app.state::<GatewayState>();
    *state.close_to_tray_item.lock().unwrap() = Some(hide_on_close.clone());
    *state.start_with_system_item.lock().unwrap() = Some(start_at_login.clone());
    *state.cli_command_item.lock().unwrap() = Some(install_cli.clone());
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
            "start_with_system" => {
                // The OS entry (Run key / LaunchAgent / XDG file) stays the
                // single truth for the CURRENT state; `autostartPrompt` only
                // records that the first-run question was answered, so a tray
                // toggle here must not write it (that would be the stale
                // mirror this module refuses to keep).
                let state = app.state::<GatewayState>();
                let enabled = state
                    .start_with_system_item
                    .lock()
                    .unwrap()
                    .as_ref()
                    .and_then(|item| item.is_checked().ok())
                    .unwrap_or_else(|| !state.start_with_system.load(Ordering::Relaxed));
                let home = default_ocr_home(
                    &app.path()
                        .resource_dir()
                        .unwrap_or(std::env::temp_dir().into()),
                );
                match set_autostart(app, enabled, &home) {
                    Ok(()) => shell_log(&home, &format!("start_with_system = {enabled}")),
                    Err(err) => {
                        // Registration failed (locked-down policy, unwritable
                        // registry): put the checkbox back.
                        {
                            let item = state.start_with_system_item.lock().unwrap();
                            if let Some(item) = item.as_ref() {
                                let _ = item.set_checked(!enabled);
                            }
                        }
                        shell_log(
                            &home,
                            &format!("start_with_system = {enabled} failed: {err}"),
                        );
                    }
                }
            }
            "install_cli" => {
                // ONE item, two verbs: the label is read from the shims on disk,
                // so a click either registers or removes the `ocr` command.
                // Installing is idempotent repair (no confirmation); removing
                // commands the operator may be using in scripts asks first.
                let home = app_home(app);
                let Some(sidecar) = sidecar_path() else {
                    shell_log(&home, "cli shims: app dir unresolved");
                    show_shim_outcome(app, &home, ShimAction::Install, false);
                    return;
                };
                // Status runs on the tray thread: a short self-exec, and its
                // answer decides what the click even MEANS.
                if run_shim_action(&home, &sidecar, "shims-status") {
                    let labels = i18n::labels();
                    let app = app.clone();
                    let confirm_home = home.clone();
                    app.dialog()
                        .message(labels.cli_uninstall_prompt_message)
                        .title(labels.cli_command_title)
                        .buttons(MessageDialogButtons::YesNo)
                        .show(move |accepted| {
                            if !accepted {
                                shell_log(&confirm_home, "cli shims uninstall declined by operator");
                                return;
                            }
                            // Blocking subprocess — off the tray thread so the
                            // menu never stutters.
                            let app = app.clone();
                            std::thread::spawn(move || {
                                let ok = run_shim_action(&confirm_home, &sidecar, "uninstall-shims");
                                finish_shim_action(
                                    &app,
                                    &confirm_home,
                                    &sidecar,
                                    ShimAction::Uninstall,
                                    ok,
                                );
                            });
                        });
                } else {
                    // Blocking subprocess — off the tray thread so the menu
                    // never stutters (cold start, worse under AV scanning).
                    let app = app.clone();
                    std::thread::spawn(move || {
                        let ok = install_cli_shims(&home, &sidecar);
                        finish_shim_action(&app, &home, &sidecar, ShimAction::Install, ok);
                    });
                }
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

/// The two directions the tray toggle can take. Distinct from success: an
/// action either ran or it did not, and the dialog says which.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ShimAction {
    Install,
    Uninstall,
}

/// Answer a tray shim click VISIBLY and leave the menu item honest.
///
/// The registration itself is best-effort and silent (the first-run offer
/// installs without a follow-up dialog), so a deliberate tray click must get
/// its own verdict — success needs saying too, because the command only works
/// in a terminal opened AFTER the PATH write.
///
/// The item is re-labelled from the shims actually on disk (`shims-status`),
/// never from `ok`: `uninstall-shims` succeeds when there was nothing to
/// remove, and a failed install may still have left a partial set behind. The
/// menu shows what IS, not what we tried. Results are logged first; a failed
/// action also points at the log, since the dialog can only carry one line.
///
/// Safe from a worker thread: the dialog plugin dispatches to the event loop.
fn finish_shim_action(
    app: &tauri::AppHandle,
    home: &std::path::Path,
    sidecar: &std::path::Path,
    action: ShimAction,
    ok: bool,
) {
    let installed = run_shim_action(home, sidecar, "shims-status");
    refresh_cli_command_item(app, installed);
    shell_log(
        home,
        &format!(
            "cli shims {} from tray: ok = {ok} (installed = {installed})",
            match action {
                ShimAction::Install => "install",
                ShimAction::Uninstall => "uninstall",
            }
        ),
    );
    show_shim_outcome(app, home, action, ok);
}

/// The dialog half of a tray shim click, split out for the one path that has no
/// sidecar to ask (an unresolved app dir): there the item keeps the verb it
/// already had, because the state is unknowable rather than false.
fn show_shim_outcome(
    app: &tauri::AppHandle,
    home: &std::path::Path,
    action: ShimAction,
    ok: bool,
) {
    let labels = i18n::labels();
    let body = match (action, ok) {
        (ShimAction::Install, true) => labels.cli_install_ok_body,
        (ShimAction::Install, false) => labels.cli_install_err_body,
        (ShimAction::Uninstall, true) => labels.cli_uninstall_ok_body,
        (ShimAction::Uninstall, false) => labels.cli_uninstall_err_body,
    };
    let body = if ok {
        body.to_string()
    } else {
        format!(
            "{}\n\n{}: {}",
            body,
            // Same "Log" word as the gateway-recovery dialog: one label for one
            // concept, so no second spelling to keep in sync.
            labels.gateway_down_log,
            home.join("desktop.log").display()
        )
    };
    app.dialog()
        .message(body)
        .title(labels.cli_command_title)
        .buttons(MessageDialogButtons::Ok)
        .show(|_| {});
}

/// Rewrite the toggle's verb. A menu item that still says "install" after a
/// successful install is the bug this function exists to prevent.
///
/// Marched onto the main thread: native menu handles are main-thread state on
/// macOS, and this runs from the shim worker. The dialog next to it is safe
/// from any thread because the plugin dispatches through the event loop; the
/// menu item is not.
fn refresh_cli_command_item(app: &tauri::AppHandle, installed: bool) {
    let handle = app.clone();
    let _ = handle.clone().run_on_main_thread(move || {
        let labels = i18n::labels();
        let state = handle.state::<GatewayState>();
        let item = state.cli_command_item.lock().unwrap();
        if let Some(item) = item.as_ref() {
            let _ = item.set_text(if installed {
                labels.cli_uninstall_menu
            } else {
                labels.cli_install_menu
            });
        }
    });
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

/// The shell's data root, resolved from the app handle. One helper so the tray
/// handlers (which have no resource dir in hand) cannot drift from `boot`'s.
fn app_home(app: &tauri::AppHandle) -> std::path::PathBuf {
    default_ocr_home(
        &app.path()
            .resource_dir()
            .unwrap_or_else(|_| std::env::temp_dir()),
    )
}

/// The bundled gateway binary next to the shell executable (Tauri's bundler
/// strips the `-{target}` triple from externalBin). `None` means the app dir is
/// unresolvable — every shim action needs it, so callers must report that.
fn sidecar_path() -> Option<std::path::PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(SIDECAR_FILE)))
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
    let push = |parts: &mut Vec<String>, entry: &str| {
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
    let sidecar = sidecar_path().ok_or_else(|| "cannot resolve app dir".to_string())?;
    let home = default_ocr_home(&resource_dir);
    // Login launches keep the window hidden (tray only). Decided before the
    // window exists so the first frame never flashes on screen.
    let autostart_launch = is_autostart_launch();

    // Two opt-in shell registrations, each asked once (visible launches only)
    // and chained inside `offer_first_run_choices` instead of being written
    // behind the operator's back: the `ocr` command (the bundled gateway
    // answers `--cli`) and the OS login launch. Both stay reachable from the
    // tray menu afterwards.
    offer_first_run_choices(app, &home, &sidecar, !autostart_launch);

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
    // A login launch stays in the tray: the gateway boots either way, and a
    // window popping up on every system start is the opposite of
    // unobtrusive. The tray "Open Console" raises it on demand.
    // Frameless: the console draws its own title bar (drag region +
    // minimize/maximize/close) so the native chrome never fights the app
    // shell. Resizing stays native — tao keeps the thick-frame hit test for
    // resizable undecorated windows. The bundled splash carries its own
    // controls too (stub/index.html): it is shown before the console origin
    // exists and again during gateway outages.
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("OmniCellRouter")
        .decorations(false)
        .inner_size(default_w, default_h)
        .visible(!autostart_launch)
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
    let saved = load_window_geometry(&home);
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
        let bounds = saved.and_then(|s| s.bounds);
        match bounds {
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
        // Restore the WINDOW STATE, not just its rect: maximizing right after
        // the normal bounds leaves the OS with those bounds as the
        // un-maximize restore target. Never serialize the maximized rect as a
        // normal size (that is the reopen-at-fullscreen bug).
        if saved.is_some_and(|s| s.maximized) {
            let _ = win2.maximize();
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
    // flicker: the loading page IS the boot UX. Remember that page: recovery
    // navigates BACK to it when the gateway drops (the console is served BY
    // the gateway).
    let splash = win.url().ok().filter(|u| u.scheme() != "about");
    let url = format!("http://127.0.0.1:{PORT}/admin/");
    let _ = win.eval(&format!("window.location.replace('{url}')"));
    // Shell-owned liveness from here on: the console page cannot report a
    // dead gateway (its own origin is gone) and has no shell IPC on this
    // origin, so this thread owns splash/recovery/failure UX.
    let monitor_app = app.handle().clone();
    let monitor_home = home.clone();
    std::thread::spawn(move || watch_gateway(monitor_app, monitor_home, splash));
    if !autostart_launch {
        let _ = win.set_focus();
    }
    shell_log(
        &home,
        if autostart_launch {
            "window created (autostart, hidden in tray)"
        } else {
            "window created"
        },
    );
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
        // The console's copy buttons write through this plugin: the webview's
        // own clipboard API raises an engine permission prompt on first use and
        // rejects while the document is not focused (the first click on an
        // inactive window). Native clipboard access has neither failure mode.
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            // Opt-in login launch. The registered entry carries AUTOSTART_ARG
            // so boot() parks in the tray. app_name pins the OS entry (Windows
            // Run value name, macOS LaunchAgent label) to the product name
            // instead of the crate name.
            tauri_plugin_autostart::Builder::new()
                .app_name("OmniCellRouter")
                .arg(AUTOSTART_ARG)
                .build(),
        )
        // Only used by the console (a REMOTE page on 127.0.0.1:4000): opens
        // links in the system browser via shell:allow-open, granted to that
        // origin by capabilities/remote-shell.json. The webview's own
        // NewWindowRequested (target="_blank") is swallowed by wry, so
        // without this the "open in browser" buttons do nothing.
        .plugin(tauri_plugin_shell::init())
        .manage(GatewayState {
            child: Mutex::new(None),
            home: Mutex::new(None),
            close_to_tray: AtomicBool::new(false),
            close_to_tray_item: Mutex::new(None),
            start_with_system: AtomicBool::new(false),
            start_with_system_item: Mutex::new(None),
            cli_command_item: Mutex::new(None),
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
            // The OS registration is authoritative — a stale mirror would
            // make the menu lie about what login actually does.
            let start_with_system = app.autolaunch().is_enabled().unwrap_or(false);
            app.state::<GatewayState>()
                .close_to_tray
                .store(close_to_tray, Ordering::Relaxed);
            app.state::<GatewayState>()
                .start_with_system
                .store(start_with_system, Ordering::Relaxed);
            // Tray before boot: a login launch must show its tray icon
            // immediately — gateway readiness can take 10-30s.
            build_tray(app, close_to_tray, start_with_system)?;
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
                // ASYNC `show`, never `blocking_show`: setup runs ON the main
                // thread and the plugin dispatches dialogs through the event
                // loop, so blocking here deadlocks (no dialog, no exit, a hung
                // process — the exact silent-GUI-death this block prevents).
                let handle = app.handle().clone();
                app.dialog()
                    .message(format!(
                        "OmniCellRouter failed to start:\n\n{msg}\n\nShell log: {}",
                        log_home.join("desktop.log").display()
                    ))
                    .title("OmniCellRouter")
                    .show(move |_| {
                        if let Some(home) = home {
                            kill_gateway_tree(&home);
                        }
                        handle.exit(1);
                    });
                return Ok(());
            }
            shell_log(
                &ocr_home,
                &format!(
                    "tray ready (locale = {}, labels = {}, close_to_tray = {close_to_tray}, start_with_system = {start_with_system})",
                    sys_locale::get_locale().unwrap_or_else(|| "en".to_string()),
                    i18n::lang()
                ),
            );
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

#[cfg(test)]
mod monitor_tests {
    use super::*;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "ocr-desktop-test-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn info_json_yields_the_serving_port() {
        let home = scratch("port");
        fs::write(
            home.join("ocr.info.json"),
            r#"{"pid":42,"port":4555,"host":"127.0.0.1"}"#,
        )
        .unwrap();
        assert_eq!(read_gateway_port(&home), Some(4555));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn restart_verdict_carries_error_and_log() {
        let home = scratch("verdict");
        fs::write(
            home.join("ocr.restart.json"),
            r#"{"status":"failed","attempts":3,"startedAt":"x","finishedAt":"y","port":4000,"host":"127.0.0.1","error":"gateway process 1 exited","logFile":"C:/tmp/ocr.log"}"#,
        )
        .unwrap();
        let verdict = read_restart_verdict(&home).expect("verdict");
        assert_eq!(verdict.status, "failed");
        assert_eq!(verdict.error.as_deref(), Some("gateway process 1 exited"));
        assert_eq!(verdict.log.as_deref(), Some("C:/tmp/ocr.log"));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn installer_choice_file_is_parsed_like_the_wizard_writes_it() {
        // Exactly what `OcrOptionsLeave` writes: CRLF lines, both boxes on.
        let both = "autostart=1\r\ncliShims=1\r\n";
        assert_eq!(installer_choice_answers(both), (Some(true), Some(true)));
        // Both boxes unchecked = two recorded DECLINES, not "unanswered".
        let neither = "autostart=0\r\ncliShims=0\r\n";
        assert_eq!(installer_choice_answers(neither), (Some(false), Some(false)));
        // Silent/passive/update installs write no file: the dialogs keep owning
        // both questions.
        assert_eq!(installer_choice_answers(""), (None, None));
    }

    #[test]
    fn old_verdict_is_not_treated_as_fresh() {
        let home = scratch("fresh");
        fs::write(home.join("ocr.restart.json"), r#"{"status":"failed"}"#).unwrap();
        let now = SystemTime::now();
        assert!(verdict_is_fresh(&home, now - Duration::from_secs(60)));
        assert!(!verdict_is_fresh(&home, now + Duration::from_secs(60)));
        let _ = fs::remove_dir_all(&home);
    }
}
