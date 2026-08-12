//! Owner-scoped, content-addressed artifact storage.

use anyhow::{Context, Result, anyhow, bail, ensure};
use chrono::{DateTime, Utc};
use pi_web_protocol::{AgentId, ArtifactId, BrowserSessionId, TabId};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

#[derive(Clone)]
pub struct ArtifactStore {
    root: Arc<PathBuf>,
    connection: Arc<Mutex<Connection>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactContext {
    pub owner_agent_id: Option<AgentId>,
    pub browser_session_id: Option<BrowserSessionId>,
    pub tab_id: Option<TabId>,
    pub source_url: Option<String>,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
}

/// Public artifact metadata. It never contains a local file-system path.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRecord {
    pub artifact_id: ArtifactId,
    pub sha256: String,
    pub owner_agent_id: AgentId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_session_id: Option<BrowserSessionId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<TabId>,
    pub media_type: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPage {
    pub record: ArtifactRecord,
    pub offset: u64,
    pub bytes: Vec<u8>,
    pub next_offset: Option<u64>,
    pub eof: bool,
}

struct StoredRow {
    record: ArtifactRecord,
    integrity_sha256: String,
}

impl ArtifactStore {
    pub fn open(data_root: impl AsRef<Path>) -> Result<Self> {
        let root = data_root.as_ref().to_path_buf();
        let artifact_root = root.join("artifacts");
        let content_root = artifact_root.join("sha256");
        create_private_dir(&root)?;
        create_private_dir(&artifact_root)?;
        create_private_dir(&content_root)?;

        let db_path = root.join("pi-web.sqlite3");
        reject_symlink_if_present(&db_path)?;
        let connection = Connection::open(&db_path)
            .with_context(|| format!("open artifact database {}", db_path.display()))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS artifacts (
                artifact_id TEXT PRIMARY KEY,
                sha256 TEXT NOT NULL,
                owner_agent_id TEXT,
                browser_session_id TEXT,
                tab_id TEXT,
                media_type TEXT NOT NULL,
                size INTEGER NOT NULL,
                path TEXT NOT NULL,
                source_url TEXT,
                created_at TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                integrity_sha256 TEXT
            );
            CREATE INDEX IF NOT EXISTS artifacts_by_hash ON artifacts(sha256);
            CREATE INDEX IF NOT EXISTS artifacts_by_session_time
                ON artifacts(owner_agent_id, browser_session_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS artifacts_by_agent_time
                ON artifacts(owner_agent_id, created_at DESC);
            "#,
        )?;
        if !has_column(&connection, "artifacts", "integrity_sha256")? {
            connection.execute("ALTER TABLE artifacts ADD COLUMN integrity_sha256 TEXT", [])?;
        }
        set_private_file(&db_path)?;
        set_private_file_if_present(&root.join("pi-web.sqlite3-wal"))?;
        set_private_file_if_present(&root.join("pi-web.sqlite3-shm"))?;
        Ok(Self { root: Arc::new(root), connection: Arc::new(Mutex::new(connection)) })
    }

    pub fn put_bytes(
        &self,
        media_type: impl Into<String>,
        bytes: &[u8],
        context: ArtifactContext,
    ) -> Result<ArtifactRecord> {
        let owner_agent_id = context
            .owner_agent_id
            .ok_or_else(|| anyhow!("artifact owner is required"))?;
        let media_type = media_type.into();
        validate_media_type(&media_type)?;
        let sha256 = hex_digest(bytes);
        let size = bytes.len() as u64;
        let integrity_sha256 = metadata_integrity(&sha256, size, &media_type);
        let path = self.path_for_hash(&sha256);
        let mut connection = self.connection.lock().map_err(|_| anyhow!("artifact DB lock poisoned"))?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        if path.exists() {
            verify_blob(&path, &sha256, size)?;
        } else {
            if let Some(parent) = path.parent() {
                create_private_dir(parent.parent().ok_or_else(|| anyhow!("invalid artifact path"))?)?;
                create_private_dir(parent)?;
            }
            let temporary = path.with_extension(format!("tmp-{}", ulid::Ulid::new()));
            let write_result = (|| -> Result<()> {
                let mut options = OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                options.mode(0o600);
                let mut file = options.open(&temporary)?;
                file.write_all(bytes)?;
                file.sync_all()?;
                fs::rename(&temporary, &path)?;
                set_private_file(&path)?;
                Ok(())
            })();
            if write_result.is_err() {
                let _ = fs::remove_file(&temporary);
            }
            write_result?;
        }

        let record = ArtifactRecord {
            artifact_id: ArtifactId::new(),
            sha256,
            owner_agent_id,
            browser_session_id: context.browser_session_id,
            tab_id: context.tab_id,
            media_type,
            size,
            source_url: context.source_url,
            created_at: Utc::now(),
            metadata: context.metadata,
        };
        insert_metadata(&transaction, &record, &integrity_sha256)?;
        transaction.commit()?;
        self.refresh_database_modes()?;
        Ok(record)
    }

    pub fn put_file(
        &self,
        media_type: impl Into<String>,
        source: impl AsRef<Path>,
        context: ArtifactContext,
    ) -> Result<ArtifactRecord> {
        let metadata = fs::symlink_metadata(source.as_ref())?;
        ensure!(metadata.file_type().is_file(), "artifact source must be a regular file");
        let bytes = fs::read(source.as_ref())?;
        self.put_bytes(media_type, &bytes, context)
    }

    pub fn get(&self, owner: &AgentId, artifact_id: &ArtifactId) -> Result<Option<ArtifactRecord>> {
        let connection = self.connection.lock().map_err(|_| anyhow!("artifact DB lock poisoned"))?;
        let row = select_owned(&connection, owner, artifact_id)?;
        match row {
            Some(row) => {
                self.verify_row(&row)?;
                Ok(Some(row.record))
            }
            None => Ok(None),
        }
    }

    pub fn page(
        &self,
        owner: &AgentId,
        artifact_id: &ArtifactId,
        offset: u64,
        limit: usize,
        expected_media_type: Option<&str>,
    ) -> Result<ArtifactPage> {
        ensure!(limit > 0, "artifact page limit must be positive");
        let connection = self.connection.lock().map_err(|_| anyhow!("artifact DB lock poisoned"))?;
        let row = select_owned(&connection, owner, artifact_id)?
            .ok_or_else(|| anyhow!("artifact not found"))?;
        self.verify_row(&row)?;
        if let Some(expected) = expected_media_type {
            ensure!(row.record.media_type == expected, "artifact media type mismatch");
        }
        ensure!(offset <= row.record.size, "offset exceeds artifact size");
        let bytes = read_verified_blob(&self.path_for_hash(&row.record.sha256), &row.record.sha256, row.record.size)?;
        let end = (offset as usize).saturating_add(limit).min(bytes.len());
        let page_bytes = bytes[offset as usize..end].to_vec();
        let next_offset = (end < bytes.len()).then_some(end as u64);
        Ok(ArtifactPage {
            record: row.record,
            offset,
            bytes: page_bytes,
            next_offset,
            eof: end >= bytes.len(),
        })
    }

    pub fn list(
        &self,
        owner: &AgentId,
        browser_session_id: Option<&BrowserSessionId>,
        limit: usize,
    ) -> Result<Vec<ArtifactRecord>> {
        let limit = limit.clamp(1, 1_000) as i64;
        let connection = self.connection.lock().map_err(|_| anyhow!("artifact DB lock poisoned"))?;
        let mut out = Vec::new();
        let sql = if browser_session_id.is_some() {
            format!("{} WHERE owner_agent_id=?1 AND browser_session_id=?2 ORDER BY created_at DESC LIMIT ?3", SELECT_COLUMNS)
        } else {
            format!("{} WHERE owner_agent_id=?1 ORDER BY created_at DESC LIMIT ?2", SELECT_COLUMNS)
        };
        let mut statement = connection.prepare(&sql)?;
        if let Some(session) = browser_session_id {
            let rows = statement.query_map(params![owner.as_ref(), session.as_ref(), limit], row_to_stored)?;
            for row in rows {
                let row = row?;
                self.verify_row(&row)?;
                out.push(row.record);
            }
        } else {
            let rows = statement.query_map(params![owner.as_ref(), limit], row_to_stored)?;
            for row in rows {
                let row = row?;
                self.verify_row(&row)?;
                out.push(row.record);
            }
        }
        Ok(out)
    }

    pub fn delete(&self, owner: &AgentId, artifact_id: &ArtifactId) -> Result<bool> {
        let mut connection = self.connection.lock().map_err(|_| anyhow!("artifact DB lock poisoned"))?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let hash: Option<String> = transaction
            .query_row(
                "SELECT sha256 FROM artifacts WHERE artifact_id=?1 AND owner_agent_id=?2",
                params![artifact_id.as_ref(), owner.as_ref()],
                |row| row.get(0),
            )
            .optional()?;
        let Some(hash) = hash else { return Ok(false) };
        transaction.execute(
            "DELETE FROM artifacts WHERE artifact_id=?1 AND owner_agent_id=?2",
            params![artifact_id.as_ref(), owner.as_ref()],
        )?;
        self.remove_hash_if_unreferenced(&transaction, &hash)?;
        transaction.commit()?;
        self.refresh_database_modes()?;
        Ok(true)
    }

    /// Remove content that has no metadata row. An immediate database transaction
    /// serializes pruning with writers in this process and in other processes.
    pub fn prune_unreferenced_bytes(&self) -> Result<usize> {
        let mut connection = self.connection.lock().map_err(|_| anyhow!("artifact DB lock poisoned"))?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let base = self.root.join("artifacts/sha256");
        let mut removed = 0;
        if !base.exists() { return Ok(0); }
        for first in fs::read_dir(&base)? {
            let first = first?;
            if !first.file_type()?.is_dir() { continue; }
            for second in fs::read_dir(first.path())? {
                let second = second?;
                if !second.file_type()?.is_dir() { continue; }
                for file in fs::read_dir(second.path())? {
                    let file = file?;
                    if !file.file_type()?.is_file() { continue; }
                    let hash = file.file_name().to_string_lossy().into_owned();
                    if is_sha256(&hash) && !hash_is_referenced(&transaction, &hash)? {
                        fs::remove_file(file.path())?;
                        removed += 1;
                    }
                }
            }
        }
        transaction.commit()?;
        Ok(removed)
    }

    fn verify_row(&self, row: &StoredRow) -> Result<()> {
        validate_media_type(&row.record.media_type)?;
        ensure!(is_sha256(&row.record.sha256), "invalid artifact digest metadata");
        ensure!(
            row.integrity_sha256 == metadata_integrity(&row.record.sha256, row.record.size, &row.record.media_type),
            "artifact metadata integrity check failed"
        );
        verify_blob(&self.path_for_hash(&row.record.sha256), &row.record.sha256, row.record.size)
    }

    fn remove_hash_if_unreferenced(&self, connection: &Connection, hash: &str) -> Result<()> {
        if !hash_is_referenced(connection, hash)? {
            let path = self.path_for_hash(hash);
            if path.exists() {
                let metadata = fs::symlink_metadata(&path)?;
                ensure!(metadata.file_type().is_file(), "artifact content is not a regular file");
                fs::remove_file(path)?;
            }
        }
        Ok(())
    }

    fn path_for_hash(&self, hash: &str) -> PathBuf {
        self.root.join("artifacts/sha256").join(&hash[0..2]).join(&hash[2..4]).join(hash)
    }

    fn refresh_database_modes(&self) -> Result<()> {
        set_private_file_if_present(&self.root.join("pi-web.sqlite3"))?;
        set_private_file_if_present(&self.root.join("pi-web.sqlite3-wal"))?;
        set_private_file_if_present(&self.root.join("pi-web.sqlite3-shm"))
    }
}

const SELECT_COLUMNS: &str = "SELECT artifact_id, sha256, owner_agent_id, browser_session_id, tab_id, media_type, size, source_url, created_at, metadata_json, integrity_sha256 FROM artifacts";

fn select_owned(connection: &Connection, owner: &AgentId, artifact_id: &ArtifactId) -> Result<Option<StoredRow>> {
    let sql = format!("{} WHERE artifact_id=?1 AND owner_agent_id=?2", SELECT_COLUMNS);
    connection
        .query_row(&sql, params![artifact_id.as_ref(), owner.as_ref()], row_to_stored)
        .optional()
        .map_err(Into::into)
}

fn insert_metadata(connection: &Connection, record: &ArtifactRecord, integrity_sha256: &str) -> Result<()> {
    connection.execute(
        "INSERT INTO artifacts (artifact_id, sha256, owner_agent_id, browser_session_id, tab_id, media_type, size, path, source_url, created_at, metadata_json, integrity_sha256) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![
            record.artifact_id.as_ref(),
            record.sha256,
            record.owner_agent_id.as_ref(),
            record.browser_session_id.as_ref().map(AsRef::<str>::as_ref),
            record.tab_id.as_ref().map(AsRef::<str>::as_ref),
            record.media_type,
            record.size as i64,
            record.sha256,
            record.source_url,
            record.created_at.to_rfc3339(),
            serde_json::to_string(&record.metadata)?,
            integrity_sha256,
        ],
    )?;
    Ok(())
}

fn row_to_stored(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredRow> {
    let created: String = row.get(8)?;
    let metadata: String = row.get(9)?;
    let owner: Option<String> = row.get(2)?;
    let size: i64 = row.get(6)?;
    if size < 0 {
        return Err(rusqlite::Error::IntegralValueOutOfRange(6, size));
    }
    Ok(StoredRow {
        record: ArtifactRecord {
            artifact_id: ArtifactId(row.get(0)?),
            sha256: row.get(1)?,
            owner_agent_id: AgentId(owner.ok_or(rusqlite::Error::InvalidColumnType(2, "owner_agent_id".into(), rusqlite::types::Type::Null))?),
            browser_session_id: row.get::<_, Option<String>>(3)?.map(BrowserSessionId),
            tab_id: row.get::<_, Option<String>>(4)?.map(TabId),
            media_type: row.get(5)?,
            size: size as u64,
            source_url: row.get(7)?,
            created_at: DateTime::parse_from_rfc3339(&created)
                .map(|value| value.with_timezone(&Utc))
                .map_err(|error| rusqlite::Error::FromSqlConversionFailure(8, rusqlite::types::Type::Text, Box::new(error)))?,
            metadata: serde_json::from_str(&metadata)
                .map_err(|error| rusqlite::Error::FromSqlConversionFailure(9, rusqlite::types::Type::Text, Box::new(error)))?,
        },
        integrity_sha256: row.get::<_, Option<String>>(10)?.unwrap_or_default(),
    })
}

fn read_verified_blob(path: &Path, expected_hash: &str, expected_size: u64) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).with_context(|| "open artifact content")?;
    ensure!(metadata.file_type().is_file(), "artifact content is not a regular file");
    #[cfg(unix)]
    let bytes = {
        const O_NOFOLLOW: i32 = 0o400000;
        let mut options = OpenOptions::new();
        options.read(true).custom_flags(O_NOFOLLOW);
        let mut file = options.open(path)?;
        let opened = file.metadata()?;
        ensure!(opened.is_file(), "artifact content is not a regular file");
        let mut bytes = Vec::new();
        use std::io::Read;
        file.read_to_end(&mut bytes)?;
        bytes
    };
    #[cfg(not(unix))]
    let bytes = fs::read(path)?;
    ensure!(bytes.len() as u64 == expected_size, "artifact size integrity check failed");
    ensure!(hex_digest(&bytes) == expected_hash, "artifact hash integrity check failed");
    Ok(bytes)
}

fn verify_blob(path: &Path, expected_hash: &str, expected_size: u64) -> Result<()> {
    read_verified_blob(path, expected_hash, expected_size).map(|_| ())
}

fn validate_media_type(value: &str) -> Result<()> {
    let essence = value.split(';').next().unwrap_or_default().trim();
    let Some((kind, subtype)) = essence.split_once('/') else { bail!("invalid artifact media type") };
    ensure!(!kind.is_empty() && !subtype.is_empty(), "invalid artifact media type");
    ensure!(value.bytes().all(|byte| byte >= 0x20 && byte != 0x7f), "invalid artifact media type");
    Ok(())
}

fn metadata_integrity(hash: &str, size: u64, media_type: &str) -> String {
    hex_digest(format!("artifact-v1\0{hash}\0{size}\0{media_type}").as_bytes())
}

fn hex_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn hash_is_referenced(connection: &Connection, hash: &str) -> Result<bool> {
    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM artifacts WHERE sha256=?1",
        params![hash],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn has_column(connection: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names.iter().any(|name| name == column))
}

fn reject_symlink_if_present(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            ensure!(!metadata.file_type().is_symlink(), "refuse symlink at {}", path.display());
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn create_private_dir(path: &Path) -> Result<()> {
    reject_symlink_if_present(path)?;
    fs::create_dir_all(path)?;
    let metadata = fs::symlink_metadata(path)?;
    ensure!(metadata.file_type().is_dir(), "expected directory at {}", path.display());
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn set_private_file(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(metadata.file_type().is_file(), "expected regular file at {}", path.display());
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

fn set_private_file_if_present(path: &Path) -> Result<()> {
    if path.exists() { set_private_file(path)?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    fn owner(value: &str) -> AgentId { AgentId(value.into()) }

    fn context(value: &str) -> ArtifactContext {
        ArtifactContext { owner_agent_id: Some(owner(value)), ..ArtifactContext::default() }
    }

    #[test]
    fn owner_scope_and_public_serialization() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let store = ArtifactStore::open(temp.path())?;
        let record = store.put_bytes("text/plain", b"synthetic", context("a"))?;
        assert!(store.get(&owner("b"), &record.artifact_id)?.is_none());
        assert!(store.list(&owner("b"), None, 10)?.is_empty());
        assert!(!store.delete(&owner("b"), &record.artifact_id)?);
        let serialized = serde_json::to_value(&record)?;
        assert!(serialized.get("path").is_none());
        assert!(!serialized.to_string().contains(temp.path().to_string_lossy().as_ref()));
        Ok(())
    }

    #[test]
    fn verifies_tamper_truncate_and_media_type() -> Result<()> {
        for replacement in [b"synthetix".as_slice(), b"short".as_slice()] {
            let temp = tempfile::tempdir()?;
            let store = ArtifactStore::open(temp.path())?;
            let record = store.put_bytes("text/plain", b"synthetic", context("a"))?;
            fs::write(store.path_for_hash(&record.sha256), replacement)?;
            assert!(store.page(&owner("a"), &record.artifact_id, 0, 10, Some("text/plain")).is_err());
        }
        let temp = tempfile::tempdir()?;
        let store = ArtifactStore::open(temp.path())?;
        let record = store.put_bytes("text/plain", b"synthetic", context("a"))?;
        assert!(store.page(&owner("a"), &record.artifact_id, 0, 10, Some("image/png")).is_err());
        {
            let connection = store.connection.lock().map_err(|_| anyhow!("test DB lock poisoned"))?;
            connection.execute(
                "UPDATE artifacts SET media_type='image/png' WHERE artifact_id=?1",
                params![record.artifact_id.as_ref()],
            )?;
        }
        assert!(store.get(&owner("a"), &record.artifact_id).is_err());
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_and_uses_restrictive_modes() -> Result<()> {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir()?;
        let store = ArtifactStore::open(temp.path())?;
        let record = store.put_bytes("text/plain", b"synthetic", context("a"))?;
        let path = store.path_for_hash(&record.sha256);
        assert_eq!(fs::metadata(&path)?.permissions().mode() & 0o777, 0o600);
        fs::remove_file(&path)?;
        let target = temp.path().join("target");
        fs::write(&target, b"synthetic")?;
        symlink(&target, &path)?;
        assert!(store.page(&owner("a"), &record.artifact_id, 0, 10, None).is_err());
        assert_eq!(fs::metadata(temp.path().join("artifacts"))?.permissions().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(temp.path().join("pi-web.sqlite3"))?.permissions().mode() & 0o777, 0o600);
        Ok(())
    }

    #[test]
    fn dedup_delete_and_prune_do_not_remove_referenced_content() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let store = Arc::new(ArtifactStore::open(temp.path())?);
        let mut threads = Vec::new();
        for index in 0..16 {
            let store = store.clone();
            threads.push(thread::spawn(move || store.put_bytes("text/plain", b"same", context(&format!("o{index}")))));
        }
        let records = threads.into_iter().map(|thread| thread.join().unwrap()).collect::<Result<Vec<_>>>()?;
        assert_eq!(store.prune_unreferenced_bytes()?, 0);
        for record in records.iter().take(15) {
            assert!(store.delete(&record.owner_agent_id, &record.artifact_id)?);
        }
        let last = records.last().unwrap();
        assert_eq!(store.page(&last.owner_agent_id, &last.artifact_id, 0, 10, None)?.bytes, b"same");
        assert!(store.delete(&last.owner_agent_id, &last.artifact_id)?);
        assert!(!store.path_for_hash(&last.sha256).exists());
        Ok(())
    }
}
