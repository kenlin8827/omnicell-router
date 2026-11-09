// Native shell i18n — the tray menu, the CLI-install prompt and the
// gateway-recovery dialog.
//
// The console's translation tables are out of reach here: the console is a
// REMOTE page whose language lives in its own localStorage, while the tray
// menu is built by the Rust shell before any document exists. The shell
// therefore follows the OS locale — same language set and prefix-match rules
// as the console's `detectLang()` (`frontend/src/i18n/languages.ts`), English
// fallback. The menu is built once at startup, so an OS language change
// applies on the next launch.
//
// Known and intended asymmetry: the console language is a per-browser choice,
// the shell's is the OS locale. A console switched to English on a zh-CN OS
// therefore keeps a Chinese tray — the two surfaces cannot share a setting
// without an IPC channel into the page (which the remote origin does not get).

/// Tray/menu + dialog copy for one language. Menu labels are plain text —
/// native menu items render backticks literally — while dialog BODIES may use
/// them as light emphasis.
pub struct TrayLabels {
    pub open: &'static str,
    pub close_to_tray: &'static str,
    pub start_with_system: &'static str,
    /// First-run choice: register the packaged gateway's `--cli` as `ocr`.
    pub cli_prompt_title: &'static str,
    pub cli_prompt_message: &'static str,
    pub cli_install_menu: &'static str,
    pub quit: &'static str,
    /// Desktop gateway-recovery dialog. The console is served BY the gateway,
    /// so a restart takes the whole UI down and no browser-side notice can
    /// survive — the shell shows this natively (see `watch_gateway`).
    pub gateway_down_title: &'static str,
    pub gateway_down_body: &'static str,
    pub gateway_down_log: &'static str,
    pub gateway_down_retry: &'static str,
}

const EN: TrayLabels = TrayLabels {
    open: "Open Console",
    close_to_tray: "Close to tray (keep gateway running)",
    start_with_system: "Start with system",
    quit: "Quit",
    gateway_down_title: "Gateway not responding",
    gateway_down_body: "The OmniCellRouter gateway stopped responding. It may still be restarting.",
    gateway_down_log: "Log",
    gateway_down_retry: "Run `ocr start` in a terminal, or reopen the app, to try again.",
    cli_prompt_title: "Command line",
    cli_prompt_message: "Install the `ocr` command on your PATH?\n\nYou can install it later from the tray menu.",
    cli_install_menu: "Install ocr command",
};

const ZH: TrayLabels = TrayLabels {
    open: "打开控制台",
    close_to_tray: "关闭时驻留托盘（网关继续运行）",
    start_with_system: "随系统启动",
    quit: "退出",
    gateway_down_title: "网关无响应",
    gateway_down_body: "OmniCellRouter 网关已停止响应，可能仍在重启中。",
    gateway_down_log: "日志",
    gateway_down_retry: "请在终端运行 `ocr start`，或退出后重新打开应用以重试。",
    cli_prompt_title: "命令行",
    cli_prompt_message: "是否把 `ocr` 命令安装到 PATH？\n\n之后也可以从托盘菜单安装。",
    cli_install_menu: "安装 ocr 命令",
};

const JA: TrayLabels = TrayLabels {
    open: "コンソールを開く",
    close_to_tray: "閉じたらトレイに常駐（ゲートウェイは稼働継続）",
    start_with_system: "システム起動時に起動",
    quit: "終了",
    gateway_down_title: "ゲートウェイが応答しません",
    gateway_down_body: "OmniCellRouter ゲートウェイが応答を停止しました。再起動中の可能性があります。",
    gateway_down_log: "ログ",
    gateway_down_retry: "ターミナルで `ocr start` を実行するか、アプリを再起動して再試行してください。",
    cli_prompt_title: "コマンドライン",
    cli_prompt_message: "`ocr` コマンドを PATH に登録しますか？\n\n後からトレイメニューでも登録できます。",
    cli_install_menu: "ocr コマンドを登録",
};

const KO: TrayLabels = TrayLabels {
    open: "콘솔 열기",
    close_to_tray: "닫으면 트레이로 (게이트웨이 계속 실행)",
    start_with_system: "시스템 시작 시 실행",
    quit: "종료",
    gateway_down_title: "게이트웨이가 응답하지 않습니다",
    gateway_down_body: "OmniCellRouter 게이트웨이가 응답을 멈췄습니다. 아직 다시 시작 중일 수 있습니다.",
    gateway_down_log: "로그",
    gateway_down_retry: "터미널에서 `ocr start`를 실행하거나 앱을 다시 열어 재시도하세요.",
    cli_prompt_title: "명령줄",
    cli_prompt_message: "`ocr` 명령을 PATH에 등록할까요?\n\n나중에 트레이 메뉴에서도 등록할 수 있습니다.",
    cli_install_menu: "ocr 명령 등록",
};

const DE: TrayLabels = TrayLabels {
    open: "Konsole öffnen",
    close_to_tray: "In den Tray minimieren (Gateway läuft weiter)",
    start_with_system: "Mit dem System starten",
    quit: "Beenden",
    gateway_down_title: "Gateway antwortet nicht",
    gateway_down_body: "Das OmniCellRouter-Gateway antwortet nicht mehr. Es startet möglicherweise noch neu.",
    gateway_down_log: "Protokoll",
    gateway_down_retry: "Führe `ocr start` im Terminal aus oder öffne die App erneut.",
    cli_prompt_title: "Kommandozeile",
    cli_prompt_message: "Den Befehl `ocr` im PATH registrieren?\n\nSpäter auch über das Tray-Menü möglich.",
    cli_install_menu: "ocr-Befehl installieren",
};

const FR: TrayLabels = TrayLabels {
    open: "Ouvrir la console",
    close_to_tray: "Réduire dans la barre d'état (passerelle maintenue)",
    start_with_system: "Démarrer avec le système",
    quit: "Quitter",
    gateway_down_title: "La passerelle ne répond pas",
    gateway_down_body: "La passerelle OmniCellRouter ne répond plus. Elle est peut-être encore en cours de redémarrage.",
    gateway_down_log: "Journal",
    gateway_down_retry: "Exécutez `ocr start` dans un terminal ou relancez l'application.",
    cli_prompt_title: "Ligne de commande",
    cli_prompt_message: "Installer la commande `ocr` dans le PATH ?\n\nVous pourrez aussi le faire depuis le menu de la barre d'état.",
    cli_install_menu: "Installer la commande ocr",
};

const ES: TrayLabels = TrayLabels {
    open: "Abrir consola",
    close_to_tray: "Cerrar a la bandeja (la puerta de enlace sigue activa)",
    start_with_system: "Iniciar con el sistema",
    quit: "Salir",
    gateway_down_title: "La puerta de enlace no responde",
    gateway_down_body: "La puerta de enlace de OmniCellRouter dejó de responder. Puede que siga reiniciándose.",
    gateway_down_log: "Registro",
    gateway_down_retry: "Ejecuta `ocr start` en una terminal o reinicia la aplicación.",
    cli_prompt_title: "Línea de comandos",
    cli_prompt_message: "¿Instalar el comando `ocr` en el PATH?\n\nTambién puedes hacerlo luego desde el menú de la bandeja.",
    cli_install_menu: "Instalar el comando ocr",
};

const PT: TrayLabels = TrayLabels {
    open: "Abrir console",
    close_to_tray: "Fechar para a bandeja (gateway continua ativo)",
    start_with_system: "Iniciar com o sistema",
    quit: "Sair",
    gateway_down_title: "O gateway não está respondendo",
    gateway_down_body: "O gateway do OmniCellRouter parou de responder. Ele pode ainda estar reiniciando.",
    gateway_down_log: "Log",
    gateway_down_retry: "Execute `ocr start` no terminal ou reinicie o aplicativo.",
    cli_prompt_title: "Linha de comando",
    cli_prompt_message: "Instalar o comando `ocr` no PATH?\n\nVocê também pode fazer isso depois pelo menu da bandeja.",
    cli_install_menu: "Instalar o comando ocr",
};

/// OS locale → tray language code. Prefix match, same rules as the console's
/// detectLang(): zh-TW → zh, pt-BR → pt, anything unsupported → en.
pub fn lang() -> &'static str {
    let locale = sys_locale::get_locale()
        .map(|l| l.to_ascii_lowercase())
        .unwrap_or_default();
    ["zh", "ja", "ko", "de", "fr", "es", "pt"]
        .into_iter()
        .find(|prefix| locale.starts_with(prefix))
        .unwrap_or("en")
}

/// Menu copy for the current OS locale.
pub fn labels() -> &'static TrayLabels {
    match lang() {
        "zh" => &ZH,
        "ja" => &JA,
        "ko" => &KO,
        "de" => &DE,
        "fr" => &FR,
        "es" => &ES,
        "pt" => &PT,
        _ => &EN,
    }
}
