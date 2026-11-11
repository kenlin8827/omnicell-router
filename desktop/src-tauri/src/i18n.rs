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
    /// Tray TOGGLE: register, or remove, the packaged gateway's `--cli` as
    /// `ocr`. Which verb the item shows is read from the marker-checked shim
    /// files (`ocr shims-status`), never from the persisted first-run answer —
    /// the operator can delete the shims by hand, and a menu item that offers
    /// the wrong verb is worse than no item.
    pub cli_install_menu: &'static str,
    pub cli_uninstall_menu: &'static str,
    /// Removing commands the operator may depend on gets a confirmation;
    /// installing (idempotent, repair-only) does not.
    pub cli_uninstall_prompt_message: &'static str,
    /// Shared title + outcome bodies for both directions. A click runs a
    /// blocking subprocess and the shell has no console, so the verdict must
    /// be a dialog — a `desktop.log` line alone reads as "nothing happened".
    pub cli_command_title: &'static str,
    pub cli_install_ok_body: &'static str,
    pub cli_install_err_body: &'static str,
    pub cli_uninstall_ok_body: &'static str,
    pub cli_uninstall_err_body: &'static str,
    /// First-run choice: register the app for OS login launch (opt-in, never
    /// enabled behind the operator's back).
    pub autostart_prompt_title: &'static str,
    pub autostart_prompt_message: &'static str,
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
    close_to_tray: "Close to tray",
    start_with_system: "Start with system",
    quit: "Quit",
    gateway_down_title: "Gateway not responding",
    gateway_down_body: "The OmniCellRouter gateway stopped responding. It may still be restarting.",
    gateway_down_log: "Log",
    gateway_down_retry: "Run `ocr start` in a terminal, or reopen the app, to try again.",
    cli_prompt_title: "Command line",
    cli_prompt_message: "Install the `ocr` command on your PATH?\n\nYou can install it later from the tray menu.",
    cli_install_menu: "Install OCR command",
    cli_uninstall_menu: "Remove OCR command",
    cli_uninstall_prompt_message: "Remove the `ocr` and `omnicell-router` commands from your PATH?\n\nThe app itself keeps working; you can reinstall from this menu at any time.",
    cli_command_title: "OCR command",
    cli_install_ok_body: "The `ocr` command is registered on your PATH.\n\nOpen a NEW terminal to use it — a terminal that is already running keeps the PATH it started with.",
    cli_install_err_body: "The `ocr` command could not be registered on your PATH.",
    cli_uninstall_ok_body: "The `ocr` and `omnicell-router` commands are removed.",
    cli_uninstall_err_body: "The `ocr` command could not be removed.",
    autostart_prompt_title: "Start with system",
    autostart_prompt_message: "Start OmniCellRouter automatically when you log in?\n\nA login launch only boots the gateway silently in the tray — the console never pops up on its own. You can change this later from the tray menu.",
};

const ZH: TrayLabels = TrayLabels {
    open: "打开控制台",
    close_to_tray: "关闭时驻留托盘",
    start_with_system: "随系统启动",
    quit: "退出",
    gateway_down_title: "网关无响应",
    gateway_down_body: "OmniCellRouter 网关已停止响应，可能仍在重启中。",
    gateway_down_log: "日志",
    gateway_down_retry: "请在终端运行 `ocr start`，或退出后重新打开应用以重试。",
    cli_prompt_title: "命令行",
    cli_prompt_message: "是否把 `ocr` 命令安装到 PATH？\n\n之后也可以从托盘菜单安装。",
    cli_install_menu: "安装 OCR 命令",
    cli_uninstall_menu: "卸载 OCR 命令",
    cli_uninstall_prompt_message: "要从 PATH 中移除 `ocr` 与 `omnicell-router` 命令吗？\n\n应用本身不受影响，随时可以从本菜单重新安装。",
    cli_command_title: "OCR 命令",
    cli_install_ok_body: "`ocr` 命令已注册到 PATH。\n\n请新开一个终端后使用——已打开的终端仍沿用启动时的 PATH。",
    cli_install_err_body: "`ocr` 命令未能注册到 PATH。",
    cli_uninstall_ok_body: "`ocr` 与 `omnicell-router` 命令已移除。",
    cli_uninstall_err_body: "`ocr` 命令未能移除。",
    autostart_prompt_title: "开机启动",
    autostart_prompt_message: "是否在登录系统时自动启动 OmniCellRouter？\n\n登录启动只在托盘里静默运行网关，控制台不会自己弹出；之后可在托盘菜单中更改。",
};

const JA: TrayLabels = TrayLabels {
    open: "コンソールを開く",
    close_to_tray: "閉じたらトレイに常駐",
    start_with_system: "システム起動時に起動",
    quit: "終了",
    gateway_down_title: "ゲートウェイが応答しません",
    gateway_down_body: "OmniCellRouter ゲートウェイが応答を停止しました。再起動中の可能性があります。",
    gateway_down_log: "ログ",
    gateway_down_retry: "ターミナルで `ocr start` を実行するか、アプリを再起動して再試行してください。",
    cli_prompt_title: "コマンドライン",
    cli_prompt_message: "`ocr` コマンドを PATH に登録しますか？\n\n後からトレイメニューでも登録できます。",
    cli_install_menu: "OCR コマンドを登録",
    cli_uninstall_menu: "OCR コマンドを削除",
    cli_uninstall_prompt_message: "PATH から `ocr` と `omnicell-router` コマンドを削除しますか？\n\nアプリ自体は動作を続けます。このメニューからいつでも再登録できます。",
    cli_command_title: "OCR コマンド",
    cli_install_ok_body: "`ocr` コマンドを PATH に登録しました。\n\n新しいターミナルで使用してください。起動済みのターミナルは古い PATH のままです。",
    cli_install_err_body: "`ocr` コマンドを PATH に登録できませんでした。",
    cli_uninstall_ok_body: "`ocr` と `omnicell-router` コマンドを削除しました。",
    cli_uninstall_err_body: "`ocr` コマンドを削除できませんでした。",
    autostart_prompt_title: "システム起動時に起動",
    autostart_prompt_message: "ログイン時に OmniCellRouter を自動起動しますか？\n\nログイン起動はトレイで静かにゲートウェイを起動するだけで、コンソールは勝手に開きません。後からトレイメニューで変更できます。",
};

const KO: TrayLabels = TrayLabels {
    open: "콘솔 열기",
    close_to_tray: "닫으면 트레이로",
    start_with_system: "시스템 시작 시 실행",
    quit: "종료",
    gateway_down_title: "게이트웨이가 응답하지 않습니다",
    gateway_down_body: "OmniCellRouter 게이트웨이가 응답을 멈췄습니다. 아직 다시 시작 중일 수 있습니다.",
    gateway_down_log: "로그",
    gateway_down_retry: "터미널에서 `ocr start`를 실행하거나 앱을 다시 열어 재시도하세요.",
    cli_prompt_title: "명령줄",
    cli_prompt_message: "`ocr` 명령을 PATH에 등록할까요?\n\n나중에 트레이 메뉴에서도 등록할 수 있습니다.",
    cli_install_menu: "OCR 명령 등록",
    cli_uninstall_menu: "OCR 명령 제거",
    cli_uninstall_prompt_message: "PATH에서 `ocr` 및 `omnicell-router` 명령을 제거할까요?\n\n앱 자체는 계속 동작하며, 이 메뉴에서 언제든 다시 등록할 수 있습니다.",
    cli_command_title: "OCR 명령",
    cli_install_ok_body: "`ocr` 명령을 PATH에 등록했습니다.\n\n새 터미널에서 사용하세요. 이미 열린 터미널은 시작할 때의 PATH를 그대로 유지합니다.",
    cli_install_err_body: "`ocr` 명령을 PATH에 등록하지 못했습니다.",
    cli_uninstall_ok_body: "`ocr` 및 `omnicell-router` 명령을 제거했습니다.",
    cli_uninstall_err_body: "`ocr` 명령을 제거하지 못했습니다.",
    autostart_prompt_title: "시스템 시작 시 실행",
    autostart_prompt_message: "로그인할 때 OmniCellRouter를 자동으로 실행할까요?\n\n로그인 실행은 트레이에서 게이트웨이만 조용히 시작하며 콘솔 창은 저절로 열리지 않습니다. 나중에 트레이 메뉴에서 변경할 수 있습니다.",
};

const DE: TrayLabels = TrayLabels {
    open: "Konsole öffnen",
    close_to_tray: "In den Tray minimieren",
    start_with_system: "Mit dem System starten",
    quit: "Beenden",
    gateway_down_title: "Gateway antwortet nicht",
    gateway_down_body: "Das OmniCellRouter-Gateway antwortet nicht mehr. Es startet möglicherweise noch neu.",
    gateway_down_log: "Protokoll",
    gateway_down_retry: "Führe `ocr start` im Terminal aus oder öffne die App erneut.",
    cli_prompt_title: "Kommandozeile",
    cli_prompt_message: "Den Befehl `ocr` im PATH registrieren?\n\nSpäter auch über das Tray-Menü möglich.",
    cli_install_menu: "OCR-Befehl installieren",
    cli_uninstall_menu: "OCR-Befehl entfernen",
    cli_uninstall_prompt_message: "Die Befehle `ocr` und `omnicell-router` aus dem PATH entfernen?\n\nDie App selbst läuft weiter; über dieses Menü ist jederzeit eine Neuinstallation möglich.",
    cli_command_title: "OCR-Befehl",
    cli_install_ok_body: "Der Befehl `ocr` ist im PATH registriert.\n\nBitte ein NEUES Terminal öffnen — ein bereits laufendes behält den PATH vom Start.",
    cli_install_err_body: "Der Befehl `ocr` konnte nicht im PATH registriert werden.",
    cli_uninstall_ok_body: "Die Befehle `ocr` und `omnicell-router` wurden entfernt.",
    cli_uninstall_err_body: "Der Befehl `ocr` konnte nicht entfernt werden.",
    autostart_prompt_title: "Mit dem System starten",
    autostart_prompt_message: "OmniCellRouter beim Anmelden automatisch starten?\n\nEin Anmelde-Start startet nur das Gateway still im Tray — die Konsole öffnet sich nicht von selbst. Später im Tray-Menü änderbar.",
};

const FR: TrayLabels = TrayLabels {
    open: "Ouvrir la console",
    close_to_tray: "Réduire dans la barre d'état",
    start_with_system: "Démarrer avec le système",
    quit: "Quitter",
    gateway_down_title: "La passerelle ne répond pas",
    gateway_down_body: "La passerelle OmniCellRouter ne répond plus. Elle est peut-être encore en cours de redémarrage.",
    gateway_down_log: "Journal",
    gateway_down_retry: "Exécutez `ocr start` dans un terminal ou relancez l'application.",
    cli_prompt_title: "Ligne de commande",
    cli_prompt_message: "Installer la commande `ocr` dans le PATH ?\n\nVous pourrez aussi le faire depuis le menu de la barre d'état.",
    cli_install_menu: "Installer la commande OCR",
    cli_uninstall_menu: "Supprimer la commande OCR",
    cli_uninstall_prompt_message: "Retirer les commandes `ocr` et `omnicell-router` du PATH ?\n\nL'application continue de fonctionner ; vous pouvez réinstaller à tout moment depuis ce menu.",
    cli_command_title: "Commande OCR",
    cli_install_ok_body: "La commande `ocr` est enregistrée dans le PATH.\n\nOuvrez un NOUVEAU terminal pour l'utiliser — un terminal déjà ouvert conserve le PATH de son démarrage.",
    cli_install_err_body: "La commande `ocr` n'a pas pu être enregistrée dans le PATH.",
    cli_uninstall_ok_body: "Les commandes `ocr` et `omnicell-router` ont été retirées.",
    cli_uninstall_err_body: "La commande `ocr` n'a pas pu être retirée.",
    autostart_prompt_title: "Démarrer avec le système",
    autostart_prompt_message: "Lancer OmniCellRouter automatiquement à la connexion ?\n\nUn lancement à la connexion démarre seulement la passerelle discrètement dans la barre d'état — la console ne s'ouvre jamais d'elle-même. Modifiable plus tard dans le menu de la barre d'état.",
};

const ES: TrayLabels = TrayLabels {
    open: "Abrir consola",
    close_to_tray: "Cerrar a la bandeja",
    start_with_system: "Iniciar con el sistema",
    quit: "Salir",
    gateway_down_title: "La puerta de enlace no responde",
    gateway_down_body: "La puerta de enlace de OmniCellRouter dejó de responder. Puede que siga reiniciándose.",
    gateway_down_log: "Registro",
    gateway_down_retry: "Ejecuta `ocr start` en una terminal o reinicia la aplicación.",
    cli_prompt_title: "Línea de comandos",
    cli_prompt_message: "¿Instalar el comando `ocr` en el PATH?\n\nTambién puedes hacerlo luego desde el menú de la bandeja.",
    cli_install_menu: "Instalar el comando OCR",
    cli_uninstall_menu: "Quitar el comando OCR",
    cli_uninstall_prompt_message: "¿Quitar los comandos `ocr` y `omnicell-router` del PATH?\n\nLa aplicación sigue funcionando; puedes reinstalarlos desde este menú cuando quieras.",
    cli_command_title: "Comando OCR",
    cli_install_ok_body: "El comando `ocr` está registrado en el PATH.\n\nAbre una terminal NUEVA para usarlo: una terminal ya abierta mantiene el PATH con el que arrancó.",
    cli_install_err_body: "No se pudo registrar el comando `ocr` en el PATH.",
    cli_uninstall_ok_body: "Se quitaron los comandos `ocr` y `omnicell-router`.",
    cli_uninstall_err_body: "No se pudo quitar el comando `ocr`.",
    autostart_prompt_title: "Iniciar con el sistema",
    autostart_prompt_message: "¿Iniciar OmniCellRouter automáticamente al entrar en el sistema?\n\nEl inicio de sesión solo arranca la pasarela en silencio dentro de la bandeja; la consola nunca se abre sola. Puedes cambiarlo luego desde el menú de la bandeja.",
};

const PT: TrayLabels = TrayLabels {
    open: "Abrir console",
    close_to_tray: "Fechar para a bandeja",
    start_with_system: "Iniciar com o sistema",
    quit: "Sair",
    gateway_down_title: "O gateway não está respondendo",
    gateway_down_body: "O gateway do OmniCellRouter parou de responder. Ele pode ainda estar reiniciando.",
    gateway_down_log: "Log",
    gateway_down_retry: "Execute `ocr start` no terminal ou reinicie o aplicativo.",
    cli_prompt_title: "Linha de comando",
    cli_prompt_message: "Instalar o comando `ocr` no PATH?\n\nVocê também pode fazer isso depois pelo menu da bandeja.",
    cli_install_menu: "Instalar o comando OCR",
    cli_uninstall_menu: "Remover o comando OCR",
    cli_uninstall_prompt_message: "Remover os comandos `ocr` e `omnicell-router` do PATH?\n\nO aplicativo continua funcionando; você pode reinstalar por este menu a qualquer momento.",
    cli_command_title: "Comando OCR",
    cli_install_ok_body: "O comando `ocr` está registrado no PATH.\n\nAbra um terminal NOVO para usá-lo — um terminal já aberto mantém o PATH com que foi iniciado.",
    cli_install_err_body: "Não foi possível registrar o comando `ocr` no PATH.",
    cli_uninstall_ok_body: "Os comandos `ocr` e `omnicell-router` foram removidos.",
    cli_uninstall_err_body: "Não foi possível remover o comando `ocr`.",
    autostart_prompt_title: "Iniciar com o sistema",
    autostart_prompt_message: "Iniciar o OmniCellRouter automaticamente ao entrar no sistema?\n\nA inicialização de sessão sobe apenas o gateway, em silêncio na bandeja — o console nunca abre sozinho. Dá para mudar depois pelo menu da bandeja.",
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
