#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

type Reply = Result<Value, String>;
struct Backend {
    input: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Reply>>>,
    sequence: AtomicU64,
    ready: Mutex<Option<Result<HashSet<String>, String>>>,
    changed: Condvar,
    stopping: AtomicBool,
    exited: AtomicBool,
    restarting: AtomicBool,
}
impl Backend {
    fn write(&self, value: Value) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|e| e.to_string())?;
        writeln!(input, "{value}").map_err(|e| e.to_string())?;
        input.flush().map_err(|e| e.to_string())
    }
    fn wait_ready(&self) -> Result<HashSet<String>, String> {
        let ready = self.ready.lock().map_err(|e| e.to_string())?;
        let (ready, _) = self
            .changed
            .wait_timeout_while(ready, Duration::from_secs(30), |r| r.is_none())
            .map_err(|e| e.to_string())?;
        ready
            .clone()
            .unwrap_or_else(|| Err("业务进程启动超时，请退出后重试".into()))
    }
    fn fail(&self, message: String) {
        *self.ready.lock().unwrap() = Some(Err(message.clone()));
        self.changed.notify_all();
        for (_, reply) in self.pending.lock().unwrap().drain() {
            let _ = reply.send(Err(message.clone()));
        }
    }
    fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let _ = self.write(json!({ "type": "shutdown" }));
    }
}

#[tauri::command]
async fn sidecar_ready(state: tauri::State<'_, Arc<Backend>>) -> Result<(), String> {
    let backend = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || backend.wait_ready().map(|_| ()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn desktop_invoke(
    channel: String,
    args: Vec<Value>,
    state: tauri::State<'_, Arc<Backend>>,
) -> Reply {
    let backend = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if backend.stopping.load(Ordering::SeqCst) {
            return Err("应用正在退出".into());
        }
        if !backend.wait_ready()?.contains(&channel) {
            return Err("不支持的业务接口".into());
        }
        let id = backend.sequence.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        backend.pending.lock().unwrap().insert(id, tx);
        if let Err(error) =
            backend.write(json!({ "type": "invoke", "id": id, "channel": channel, "args": args }))
        {
            backend.pending.lock().unwrap().remove(&id);
            return Err(error);
        }
        // A timeout must never replay a publication. Completion remains in the task store.
        let response = rx
            .recv_timeout(Duration::from_secs(600))
            .unwrap_or_else(|_| Err("操作仍可能在执行，请查看任务状态；不要重复发布".into()));
        backend.pending.lock().unwrap().remove(&id);
        response
    })
    .await
    .map_err(|e| e.to_string())?
}

fn native(app: &tauri::AppHandle, method: &str, options: &Value) -> Reply {
    match method {
        "showWindow" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            Ok(Value::Null)
        }
        "openExternal" => {
            let url = options["url"].as_str().ok_or("URL required")?;
            if !url.starts_with("https://") && !url.starts_with("http://") {
                return Err("Unsupported external URL".into());
            }
            open::that(url).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "trashItem" => {
            trash::delete(options["path"].as_str().ok_or("Path required")?)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "openPath" => {
            open::that(options["path"].as_str().ok_or("Path required")?)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "message" => {
            let text = format!(
                "{}\n{}",
                options["message"].as_str().unwrap_or(""),
                options["detail"].as_str().unwrap_or("")
            );
            let mut dialog = app
                .dialog()
                .message(text)
                .title(options["title"].as_str().unwrap_or("NediaMatrix"));
            let buttons = options["buttons"].as_array();
            if let Some(buttons) = buttons {
                if buttons.len() != 2 {
                    return Err("Application supports two-button dialogs only".into());
                }
                dialog = dialog.buttons(MessageDialogButtons::OkCancelCustom(
                    buttons[0].as_str().unwrap_or("确定").into(),
                    buttons[1].as_str().unwrap_or("取消").into(),
                ));
            }
            let accepted = dialog.blocking_show();
            Ok(
                json!({ "response": if accepted { 0 } else { options["cancelId"].as_u64().unwrap_or(1) } }),
            )
        }
        "openDialog" | "saveDialog" => {
            let mut dialog = app
                .dialog()
                .file()
                .set_title(options["title"].as_str().unwrap_or("选择文件"));
            if let Some(filters) = options["filters"].as_array() {
                for filter in filters {
                    let extensions: Vec<&str> = filter["extensions"]
                        .as_array()
                        .map(|items| items.iter().filter_map(Value::as_str).collect())
                        .unwrap_or_default();
                    dialog =
                        dialog.add_filter(filter["name"].as_str().unwrap_or("文件"), &extensions);
                }
            }
            if method == "saveDialog" {
                if let Some(path) = options["defaultPath"].as_str() {
                    let path = std::path::Path::new(path);
                    if let Some(parent) = path.parent() {
                        dialog = dialog.set_directory(parent);
                    }
                    if let Some(name) = path.file_name() {
                        dialog = dialog.set_file_name(name.to_string_lossy());
                    }
                }
                let file = dialog.blocking_save_file().map(|p| p.to_string());
                Ok(json!({ "canceled": file.is_none(), "filePath": file }))
            } else {
                let multiple = options["properties"]
                    .as_array()
                    .is_some_and(|p| p.iter().any(|v| v == "multiSelections"));
                let files = if multiple {
                    dialog.blocking_pick_files()
                } else {
                    dialog.blocking_pick_file().map(|p| vec![p])
                };
                let paths: Vec<String> = files
                    .unwrap_or_default()
                    .into_iter()
                    .map(|p| p.to_string())
                    .collect();
                Ok(json!({ "canceled": paths.is_empty(), "filePaths": paths }))
            }
        }
        _ => Err(format!("Unsupported native request: {method}")),
    }
}

fn start_backend(app: &tauri::AppHandle) -> Result<Arc<Backend>, Box<dyn std::error::Error>> {
    let runtime = if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runtime")
    } else {
        app.path().resource_dir()?.join("runtime")
    };
    let data = app.path().app_local_data_dir()?;
    std::fs::create_dir_all(&data)?;
    let mut command = Command::new(runtime.join(if cfg!(windows) { "node.exe" } else { "node" }));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW: the GUI owns the sidecar.
    }
    let mut child = command
        .arg(runtime.join("sidecar.mjs"))
        .current_dir(&runtime)
        .env("NEDIA_TAURI_RUNTIME", &runtime)
        .env("NEDIA_TAURI_DATA", data)
        .env(
            "NEDIA_TAURI_PACKAGED",
            if cfg!(debug_assertions) { "0" } else { "1" },
        )
        .env("NEDIA_TAURI_EXECUTABLE", std::env::current_exe()?)
        .env("NEDIA_TAURI_PARENT_PID", std::process::id().to_string())
        .env("NEDIA_ELECTRON_APP_DATA", app.path().config_dir()?)
        .env("NEDIA_TAURI_SHARED_USER_DATA", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let stdout = child.stdout.take().ok_or("Missing sidecar stdout")?;
    let backend = Arc::new(Backend {
        input: Mutex::new(child.stdin.take().ok_or("Missing sidecar stdin")?),
        child: Mutex::new(child),
        pending: Mutex::new(HashMap::new()),
        sequence: AtomicU64::new(1),
        ready: Mutex::new(None),
        changed: Condvar::new(),
        stopping: AtomicBool::new(false),
        exited: AtomicBool::new(false),
        restarting: AtomicBool::new(false),
    });
    let reader = backend.clone();
    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                eprintln!("Invalid sidecar output");
                continue;
            };
            match message["type"].as_str() {
                Some("ready") => {
                    let channels = message["channels"]
                        .as_array()
                        .map(|v| {
                            v.iter()
                                .filter_map(|v| v.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    *reader.ready.lock().unwrap() = Some(Ok(channels));
                    reader.changed.notify_all();
                }
                Some("result") => {
                    if let Some(id) = message["id"].as_u64() {
                        if let Some(reply) = reader.pending.lock().unwrap().remove(&id) {
                            let _ = reply.send(if let Some(error) = message["error"].as_str() {
                                Err(error.into())
                            } else {
                                Ok(message["result"].clone())
                            });
                        }
                    }
                }
                Some("event") => {
                    let _ = handle.emit_to("main", "sidecar-event", &message);
                }
                Some("native") => {
                    let handle = handle.clone();
                    let backend = reader.clone();
                    std::thread::spawn(move || {
                        let result = native(
                            &handle,
                            message["method"].as_str().unwrap_or(""),
                            &message["options"],
                        );
                        let reply = match result {
                            Ok(result) => {
                                json!({ "type": "native-result", "id": message["id"], "result": result })
                            }
                            Err(error) => {
                                json!({ "type": "native-result", "id": message["id"], "error": error })
                            }
                        };
                        let _ = backend.write(reply);
                    });
                }
                Some("restart") => reader.restarting.store(true, Ordering::SeqCst),
                Some("exit") => reader.stopping.store(true, Ordering::SeqCst),
                Some("fatal") => reader.fail(
                    message["error"]
                        .as_str()
                        .unwrap_or("业务进程启动失败")
                        .into(),
                ),
                _ => {}
            }
        }
        let _ = reader.child.lock().unwrap().wait();
        reader.exited.store(true, Ordering::SeqCst);
        reader.fail("业务进程已停止，请重新打开应用；不要重复发布".into());
        if reader.restarting.load(Ordering::SeqCst) {
            handle.restart();
        } else if reader.stopping.load(Ordering::SeqCst) {
            handle.exit(0);
        } else {
            let _ = handle.emit_to("main", "sidecar-failed", "业务进程意外退出");
        }
    });
    Ok(backend)
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![desktop_invoke, sidecar_ready])
        .setup(|app| {
            let backend = start_backend(app.handle())?;
            app.manage(backend);
            if cfg!(debug_assertions) && std::env::var_os("NEDIA_COEXISTENCE_TEST_ROOT").is_none() {
                if let Some(window) = app.get_webview_window("main") {
                    window.set_title("NediaMatrix · Tauri（共享正式 userData）")?;
                }
            }
            use tauri::{
                menu::{Menu, MenuItem},
                tray::TrayIconBuilder,
            };
            let show = MenuItem::with_id(app, "show", "打开 NediaMatrix", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("NediaMatrix")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "quit" {
                        app.exit(0);
                    } else if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("无法启动 NediaMatrix");
    app.run(|handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let backend = handle.state::<Arc<Backend>>();
            if !backend.exited.load(Ordering::SeqCst) {
                api.prevent_exit();
                backend.shutdown();
            }
        }
    });
}
