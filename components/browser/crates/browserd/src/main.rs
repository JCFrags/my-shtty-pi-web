use anyhow::Result;
use pi_browserd::{Coordinator, DaemonConfig, XdgPaths};
use serde::Serialize;
use serde_json::json;
use std::{path::PathBuf, process::Stdio};
use tokio::process::Command;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    initialize_tracing();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|value| value == "doctor") {
        let machine = args.iter().any(|value| value == "--json");
        let report = doctor().await;
        if machine {
            println!("{}", serde_json::to_string_pretty(&report)?);
        } else {
            println!("Pi Web doctor: {}", if report.ok { "ok" } else { "problems found" });
            for check in &report.checks {
                println!("{:<24} {:<8} {}", check.name, if check.ok { "ok" } else { "failed" }, check.detail);
            }
        }
        if !report.ok { std::process::exit(1); }
        return Ok(());
    }

    let paths = XdgPaths::resolve();
    paths.ensure()?;
    let config_path = argument_value(&args, "--config")
        .map(PathBuf::from)
        .unwrap_or_else(|| paths.config.join("config.toml"));
    let config = DaemonConfig::load(&config_path)?;
    let coordinator = Coordinator::new(config, paths).await?;
    pi_browserd::run(coordinator).await
}

fn initialize_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("pi_browserd=info,tower_http=info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .init();
}

fn argument_value(args: &[String], name: &str) -> Option<String> {
    args.windows(2).find(|window| window[0] == name).map(|window| window[1].clone())
}

#[derive(Serialize)]
struct DoctorReport {
    ok: bool,
    protocol_version: &'static str,
    checks: Vec<DoctorCheck>,
}

#[derive(Serialize)]
struct DoctorCheck {
    name: String,
    ok: bool,
    detail: String,
}

async fn doctor() -> DoctorReport {
    let paths = XdgPaths::resolve();
    let mut checks = Vec::new();
    for (name, binary, args) in [
        ("agent-browser", "agent-browser", vec!["--version"]),
        ("chromium", "chromium-browser", vec!["--version"]),
        ("podman", "podman", vec!["--version"]),
    ] {
        checks.push(binary_check(name, binary, &args).await);
    }
    let visual_env = paths.config.join("visual-browser.env");
    if let Ok(content) = std::fs::read_to_string(&visual_env) {
        if let Some(binary) = content.lines().find_map(|line| {
            line.strip_prefix("PI_WEB_VISUAL_CHROMIUM_EXECUTABLE=")
                .map(|value| value.trim().trim_matches('"'))
                .filter(|value| !value.is_empty())
        }) {
            checks.push(binary_check("visual-chromium", binary, &["--version"]).await);
        }
    }
    let path_check = match paths.ensure() {
        Ok(()) => DoctorCheck { name: "xdg-paths".into(), ok: true, detail: paths.data.display().to_string() },
        Err(error) => DoctorCheck { name: "xdg-paths".into(), ok: false, detail: error.to_string() },
    };
    checks.push(path_check);
    checks.push(DoctorCheck {
        name: "browserd-descriptor".into(),
        ok: paths.descriptor_path().is_file(),
        detail: paths.descriptor_path().display().to_string(),
    });
    checks.push(DoctorCheck {
        name: "capability-policy".into(),
        ok: true,
        detail: json!({ "supportedPathIds": pi_web_protocol::SUPPORTED_PATH_IDS, "explicitAddressing": true, "silentFallback": false }).to_string(),
    });
    DoctorReport {
        ok: checks.iter().filter(|check| check.name != "browserd-descriptor").all(|check| check.ok),
        protocol_version: pi_web_protocol::PROTOCOL_VERSION,
        checks,
    }
}

async fn binary_check(name: &str, binary: &str, args: &[&str]) -> DoctorCheck {
    match Command::new(binary)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
    {
        Ok(output) => {
            let text = if output.stdout.is_empty() { &output.stderr } else { &output.stdout };
            DoctorCheck {
                name: name.into(),
                ok: output.status.success(),
                detail: String::from_utf8_lossy(text).trim().to_owned(),
            }
        }
        Err(error) => DoctorCheck { name: name.into(), ok: false, detail: error.to_string() },
    }
}
