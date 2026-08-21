import { createHash, randomBytes } from "node:crypto";
import { createReadStream, watch as watchFileSystem } from "node:fs";
import { chmod, mkdir, readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { extname, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const MEDIA_EXTENSIONS = new Set([
  ".3gp",
  ".avif",
  ".avi",
  ".bmp",
  ".dng",
  ".gif",
  ".heic",
  ".heif",
  ".jfif",
  ".jpeg",
  ".jpg",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".png",
  ".tif",
  ".tiff",
  ".webm",
  ".webp",
]);
const VIDEO_EXTENSIONS = new Set([".3gp", ".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"]);
const HASH_SPEC = "sha256-v1";
const MAX_JOB_ATTEMPTS = 5;

function required(options, name) {
  const value = options.get(name);
  if (!value) throw new Error(`missing required argument --${name}`);
  return value;
}

export function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${flag ?? "end of arguments"}`);
    }
    options.set(flag.slice(2), value);
  }
  return {
    source: resolve(required(options, "source")),
    state: resolve(required(options, "state")),
    sentinel: options.get("sentinel") ?? null,
    host: options.get("host") ?? "127.0.0.1",
    port: Number(options.get("port") ?? "3924"),
    scanIntervalMs: Number(options.get("scan-interval-ms") ?? "600000"),
    settleIntervalMs: Number(options.get("settle-interval-ms") ?? "15000"),
    watchDebounceMs: Number(options.get("watch-debounce-ms") ?? "2000"),
    retryIntervalMs: Number(options.get("retry-interval-ms") ?? "15000"),
  };
}

function calendarDate(path, mtimeMs) {
  const match = path.match(/^(\d{4})\/(\d{2})\/(\d{2})(?:\/|$)/);
  if (match) {
    const [, year, month, day] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (
      date.getUTCFullYear() === Number(year) &&
      date.getUTCMonth() === Number(month) - 1 &&
      date.getUTCDate() === Number(day)
    ) {
      return { value: `${year}-${month}-${day}`, source: "path" };
    }
  }
  return { value: new Date(mtimeMs).toISOString().slice(0, 10), source: "file-mtime" };
}

function opaqueId(prefix) {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

function publicPath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function fingerprint(entry) {
  return `${entry.size}:${entry.mtimeNs}:${entry.inode}`;
}

async function walk(root, directory, entries) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(root, path, entries);
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = extname(entry.name).toLowerCase();
    if (!MEDIA_EXTENSIONS.has(extension)) continue;
    const status = await stat(path, { bigint: true });
    const relativePath = publicPath(root, path);
    const date = calendarDate(relativePath, Number(status.mtimeMs));
    entries.push({
      path: relativePath,
      name: entry.name,
      size: Number(status.size),
      mtimeNs: status.mtimeNs.toString(),
      mtimeMs: Number(status.mtimeMs),
      device: status.dev.toString(),
      inode: status.ino.toString(),
      date: date.value,
      dateSource: date.source,
      type: VIDEO_EXTENSIONS.has(extension) ? "video" : "image",
    });
  }
}

export async function discoverMedia(root, sentinel = null) {
  const rootStatus = await stat(root, { bigint: true });
  if (!rootStatus.isDirectory()) throw new Error("photo source is not a directory");
  let sentinelPath = null;
  if (sentinel) {
    sentinelPath = resolve(root, sentinel);
    if (sentinelPath !== root && !sentinelPath.startsWith(`${root}${sep}`)) {
      throw new Error("photo source sentinel escapes source root");
    }
    await stat(sentinelPath);
  }
  const entries = [];
  await walk(root, root, entries);
  const finalRootStatus = await stat(root, { bigint: true });
  if (rootStatus.dev !== finalRootStatus.dev || rootStatus.ino !== finalRootStatus.ino) {
    throw new Error("photo source changed during scan");
  }
  if (sentinelPath) await stat(sentinelPath);
  return entries;
}

export function migrate(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  const version = Number(db.prepare("PRAGMA user_version").get().user_version);
  if (version > 2) throw new Error(`catalog schema ${version} is newer than this server supports`);
  if (version === 0) transaction(db, () => db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY,
      root TEXT NOT NULL UNIQUE,
      sentinel TEXT,
      generation INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'waiting',
      scan_started_at TEXT,
      last_success_at TEXT,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY,
      hash_algorithm TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(hash_algorithm, content_hash, size)
    );
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY,
      source_id INTEGER NOT NULL REFERENCES sources(id),
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ns TEXT NOT NULL,
      device TEXT NOT NULL,
      inode TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL,
      media_date TEXT NOT NULL,
      media_type TEXT NOT NULL,
      state TEXT NOT NULL,
      stable_observations INTEGER NOT NULL,
      last_seen_generation INTEGER NOT NULL,
      missing_at TEXT,
      asset_id INTEGER REFERENCES assets(id),
      UNIQUE(source_id, path)
    );
    CREATE INDEX IF NOT EXISTS locations_timeline
      ON locations(state, media_date DESC, path);
    CREATE TABLE IF NOT EXISTS stage_specs (
      id INTEGER PRIMARY KEY,
      stage TEXT NOT NULL,
      spec_key TEXT NOT NULL UNIQUE,
      adapter_version TEXT NOT NULL,
      model_digest TEXT,
      config_digest TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id INTEGER PRIMARY KEY,
      asset_id INTEGER NOT NULL REFERENCES assets(id),
      stage_spec_id INTEGER NOT NULL REFERENCES stage_specs(id),
      input_fingerprint TEXT NOT NULL,
      value_text TEXT,
      value_blob BLOB,
      created_at TEXT NOT NULL,
      UNIQUE(asset_id, stage_spec_id, input_fingerprint)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY,
      location_id INTEGER REFERENCES locations(id),
      asset_id INTEGER REFERENCES assets(id),
      stage_spec_id INTEGER NOT NULL REFERENCES stage_specs(id),
      input_fingerprint TEXT NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((location_id IS NOT NULL) != (asset_id IS NOT NULL)),
      UNIQUE(location_id, stage_spec_id, input_fingerprint),
      UNIQUE(asset_id, stage_spec_id, input_fingerprint)
    );
    CREATE INDEX IF NOT EXISTS jobs_runnable ON jobs(state, available_at, id);
    PRAGMA user_version = 1;
  `));
  if (version < 2) transaction(db, () => {
    const migratedAt = new Date().toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO stage_specs
        (stage, spec_key, adapter_version, model_digest, config_digest, schema_version)
      VALUES ('content-hash', ?, 'node-crypto-sha256-v1', NULL, 'sha256', 1)
    `).run(HASH_SPEC);
    db.exec(`
      ALTER TABLE assets ADD COLUMN media_id TEXT;
      ALTER TABLE locations ADD COLUMN media_date_source TEXT;
      ALTER TABLE locations ADD COLUMN media_date_observed_at TEXT;
      ALTER TABLE stage_specs ADD COLUMN created_at TEXT;
      ALTER TABLE artifacts ADD COLUMN input_key TEXT;
      ALTER TABLE jobs ADD COLUMN input_key TEXT;
      ALTER TABLE jobs ADD COLUMN lease_token TEXT;

      CREATE TABLE pipeline_slots (
        slot TEXT PRIMARY KEY,
        stage TEXT NOT NULL,
        stage_spec_id INTEGER NOT NULL REFERENCES stage_specs(id),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE embedding_contracts (
        stage_spec_id INTEGER PRIMARY KEY REFERENCES stage_specs(id),
        element_type TEXT NOT NULL CHECK (element_type = 'float32-le'),
        dimensions INTEGER NOT NULL CHECK (dimensions > 0),
        created_at TEXT NOT NULL,
        UNIQUE (stage_spec_id, element_type, dimensions)
      ) STRICT;
      CREATE TABLE embeddings (
        asset_id INTEGER NOT NULL REFERENCES assets(id),
        stage_spec_id INTEGER NOT NULL,
        input_key TEXT NOT NULL CHECK (length(input_key) > 0),
        element_type TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector BLOB NOT NULL CHECK (length(vector) = dimensions * 4),
        created_at TEXT NOT NULL,
        PRIMARY KEY (asset_id, stage_spec_id, input_key),
        FOREIGN KEY (stage_spec_id, element_type, dimensions)
          REFERENCES embedding_contracts(stage_spec_id, element_type, dimensions)
      ) STRICT;
    `);
    const assignMediaId = db.prepare("UPDATE assets SET media_id = ? WHERE id = ?");
    for (const asset of db.prepare("SELECT id FROM assets WHERE media_id IS NULL").all()) {
      assignMediaId.run(opaqueId("med"), asset.id);
    }
    db.prepare(`
      UPDATE locations SET media_date_source = 'legacy-path-or-mtime',
        media_date_observed_at = ? WHERE media_date_source IS NULL
    `).run(migratedAt);
    db.prepare("UPDATE stage_specs SET created_at = ? WHERE created_at IS NULL").run(migratedAt);
    db.exec(`
      UPDATE artifacts SET input_key = input_fingerprint WHERE input_key IS NULL;
      UPDATE jobs SET input_key = input_fingerprint WHERE input_key IS NULL;
      UPDATE jobs SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL
        WHERE state = 'running';
      UPDATE jobs SET lease_owner = NULL, lease_expires_at = NULL WHERE state != 'running';
      CREATE UNIQUE INDEX assets_media_id ON assets(media_id);
      CREATE UNIQUE INDEX artifacts_input_key
        ON artifacts(asset_id, stage_spec_id, input_key);
      CREATE UNIQUE INDEX jobs_location_input_key
        ON jobs(location_id, stage_spec_id, input_key) WHERE location_id IS NOT NULL;
      CREATE UNIQUE INDEX jobs_asset_input_key
        ON jobs(asset_id, stage_spec_id, input_key) WHERE asset_id IS NOT NULL;
      CREATE TRIGGER assets_require_media_id
        BEFORE INSERT ON assets WHEN NEW.media_id IS NULL
        BEGIN SELECT RAISE(ABORT, 'assets.media_id is required'); END;
      CREATE TRIGGER assets_media_id_immutable
        BEFORE UPDATE OF media_id ON assets
        WHEN NEW.media_id IS NULL OR NEW.media_id != OLD.media_id
        BEGIN SELECT RAISE(ABORT, 'assets.media_id is immutable'); END;
      CREATE TRIGGER stage_specs_require_created_at
        BEFORE INSERT ON stage_specs WHEN NEW.created_at IS NULL
        BEGIN SELECT RAISE(ABORT, 'stage_specs.created_at is required'); END;
      CREATE TRIGGER stage_specs_immutable_update
        BEFORE UPDATE ON stage_specs
        BEGIN SELECT RAISE(ABORT, 'stage specs are immutable'); END;
      CREATE TRIGGER stage_specs_immutable_delete
        BEFORE DELETE ON stage_specs
        BEGIN SELECT RAISE(ABORT, 'stage specs are immutable'); END;
      CREATE TRIGGER pipeline_slots_match_stage_insert
        BEFORE INSERT ON pipeline_slots
        WHEN NEW.stage != (SELECT stage FROM stage_specs WHERE id = NEW.stage_spec_id)
        BEGIN SELECT RAISE(ABORT, 'pipeline slot stage mismatch'); END;
      CREATE TRIGGER pipeline_slots_match_stage_update
        BEFORE UPDATE ON pipeline_slots
        WHEN NEW.stage != (SELECT stage FROM stage_specs WHERE id = NEW.stage_spec_id)
        BEGIN SELECT RAISE(ABORT, 'pipeline slot stage mismatch'); END;
      CREATE TRIGGER artifacts_require_input_key
        BEFORE INSERT ON artifacts WHEN NEW.input_key IS NULL OR length(NEW.input_key) = 0
        BEGIN SELECT RAISE(ABORT, 'artifacts.input_key is required'); END;
      CREATE TRIGGER artifacts_input_key_immutable
        BEFORE UPDATE OF input_key ON artifacts
        WHEN NEW.input_key IS NULL OR length(NEW.input_key) = 0 OR NEW.input_key != OLD.input_key
        BEGIN SELECT RAISE(ABORT, 'artifacts.input_key is immutable'); END;
      CREATE TRIGGER jobs_require_input_key
        BEFORE INSERT ON jobs WHEN NEW.input_key IS NULL OR length(NEW.input_key) = 0
        BEGIN SELECT RAISE(ABORT, 'jobs.input_key is required'); END;
      CREATE TRIGGER jobs_input_key_immutable
        BEFORE UPDATE OF input_key ON jobs
        WHEN NEW.input_key IS NULL OR length(NEW.input_key) = 0 OR NEW.input_key != OLD.input_key
        BEGIN SELECT RAISE(ABORT, 'jobs.input_key is immutable'); END;
      CREATE TRIGGER jobs_require_valid_lease_insert
        BEFORE INSERT ON jobs WHEN
          (NEW.state = 'running' AND
            (NEW.lease_token IS NULL OR NEW.lease_owner IS NULL OR NEW.lease_expires_at IS NULL)) OR
          (NEW.state != 'running' AND
            (NEW.lease_token IS NOT NULL OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL))
        BEGIN SELECT RAISE(ABORT, 'job lease state is invalid'); END;
      CREATE TRIGGER jobs_require_valid_lease_update
        BEFORE UPDATE ON jobs WHEN
          (NEW.state = 'running' AND
            (NEW.lease_token IS NULL OR NEW.lease_owner IS NULL OR NEW.lease_expires_at IS NULL)) OR
          (NEW.state != 'running' AND
            (NEW.lease_token IS NOT NULL OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL))
        BEGIN SELECT RAISE(ABORT, 'job lease state is invalid'); END;
      CREATE TRIGGER locations_require_date_provenance_insert
        BEFORE INSERT ON locations
        WHEN NEW.media_date_source IS NULL OR NEW.media_date_observed_at IS NULL
        BEGIN SELECT RAISE(ABORT, 'location date provenance is required'); END;
      CREATE TRIGGER embeddings_immutable_update
        BEFORE UPDATE ON embeddings
        BEGIN SELECT RAISE(ABORT, 'embeddings are immutable'); END;
      CREATE TRIGGER embeddings_immutable_delete
        BEFORE DELETE ON embeddings
        BEGIN SELECT RAISE(ABORT, 'embeddings are immutable'); END;
      CREATE TRIGGER embedding_contracts_immutable_update
        BEFORE UPDATE ON embedding_contracts
        BEGIN SELECT RAISE(ABORT, 'embedding contracts are immutable'); END;
      CREATE TRIGGER embedding_contracts_immutable_delete
        BEFORE DELETE ON embedding_contracts
        BEGIN SELECT RAISE(ABORT, 'embedding contracts are immutable'); END;
    `);
    const hashSpec = db.prepare("SELECT id FROM stage_specs WHERE spec_key = ?").get(HASH_SPEC);
    db.prepare(`
      INSERT INTO pipeline_slots (slot, stage, stage_spec_id, updated_at)
      VALUES ('content-hash/current', 'content-hash', ?, ?)
    `).run(hashSpec.id, migratedAt);
    db.exec("PRAGMA user_version = 2");
  });
}

function transaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export class Catalog {
  constructor(path, root, sentinel = null) {
    this.root = root;
    this.db = new DatabaseSync(path);
    migrate(this.db);
    this.sourceId = Number(
      this.db.prepare(`
        INSERT INTO sources (root, sentinel) VALUES (?, ?)
        ON CONFLICT(root) DO UPDATE SET sentinel = excluded.sentinel
        RETURNING id
      `).get(root, sentinel).id
    );
    this.db.prepare(`
      UPDATE jobs SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL, lease_token = NULL,
        updated_at = ? WHERE state = 'running'
    `).run(new Date().toISOString());
  }

  close() {
    this.db.close();
  }

  currentHashSpecId() {
    const spec = this.db.prepare(`
      SELECT stage_specs.id, stage_specs.stage, stage_specs.spec_key AS specKey,
        stage_specs.adapter_version AS adapterVersion, stage_specs.model_digest AS modelDigest,
        stage_specs.config_digest AS configDigest, stage_specs.schema_version AS schemaVersion
      FROM pipeline_slots
      JOIN stage_specs ON stage_specs.id = pipeline_slots.stage_spec_id
      WHERE pipeline_slots.slot = 'content-hash/current'
    `).get();
    if (
      !spec ||
      spec.stage !== "content-hash" ||
      spec.specKey !== HASH_SPEC ||
      spec.adapterVersion !== "node-crypto-sha256-v1" ||
      spec.modelDigest !== null ||
      spec.configDigest !== "sha256" ||
      Number(spec.schemaVersion) !== 1
    ) {
      throw new Error("content-hash/current is unsupported by this worker");
    }
    return Number(spec.id);
  }

  scanStarted() {
    this.db.prepare(`
      UPDATE sources SET state = 'scanning', scan_started_at = ?, last_error = NULL WHERE id = ?
    `).run(new Date().toISOString(), this.sourceId);
  }

  scanFailed(error) {
    this.db.prepare("UPDATE sources SET state = 'degraded', last_error = ? WHERE id = ?").run(
      String(error?.message ?? error).slice(0, 1000),
      this.sourceId
    );
  }

  /** Commits one authoritative full-source observation; failed walks must never call this. */
  reconcile(entries) {
    const now = new Date().toISOString();
    return transaction(this.db, () => {
      const hashSpecId = this.currentHashSpecId();
      const source = this.db.prepare("SELECT generation FROM sources WHERE id = ?").get(this.sourceId);
      const generation = Number(source.generation) + 1;
      const existingStatement = this.db.prepare(`
        SELECT id, input_fingerprint, state, stable_observations, asset_id
        FROM locations WHERE source_id = ? AND path = ?
      `);
      const insertStatement = this.db.prepare(`
        INSERT INTO locations
          (source_id, path, name, size, mtime_ns, device, inode, input_fingerprint,
           media_date, media_type, state, stable_observations, last_seen_generation,
           media_date_source, media_date_observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', 1, ?, ?, ?)
      `);
      const updateStatement = this.db.prepare(`
        UPDATE locations SET name = ?, size = ?, mtime_ns = ?, device = ?, inode = ?,
          input_fingerprint = ?, media_date = ?, media_type = ?, state = ?,
          stable_observations = ?, last_seen_generation = ?, missing_at = NULL, asset_id = ?,
          media_date_source = ?, media_date_observed_at = ?
        WHERE id = ?
      `);
      const enqueueStatement = this.db.prepare(`
        INSERT INTO jobs
          (location_id, stage_spec_id, input_fingerprint, input_key, state,
           available_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
        ON CONFLICT(location_id, stage_spec_id, input_fingerprint) DO UPDATE SET
          state = 'queued', attempts = 0, available_at = excluded.available_at,
          input_key = excluded.input_key, lease_owner = NULL, lease_expires_at = NULL,
          lease_token = NULL, last_error = NULL,
          updated_at = excluded.updated_at
        WHERE jobs.state IN ('cancelled', 'failed', 'superseded')
      `);
      const supersedeStatement = this.db.prepare(`
        UPDATE jobs SET state = 'superseded', lease_owner = NULL, lease_expires_at = NULL,
          lease_token = NULL, updated_at = ?
        WHERE location_id = ? AND input_fingerprint != ? AND state IN ('queued', 'running')
      `);

      let candidates = 0;
      let present = 0;
      for (const entry of entries) {
        const inputFingerprint = fingerprint(entry);
        const existing = existingStatement.get(this.sourceId, entry.path);
        let locationId;
        let state;
        let observations;
        let assetId = null;
        if (!existing) {
          locationId = Number(insertStatement.run(
            this.sourceId,
            entry.path,
            entry.name,
            entry.size,
            entry.mtimeNs,
            entry.device,
            entry.inode,
            inputFingerprint,
            entry.date,
            entry.type,
            generation,
            entry.dateSource,
            now
          ).lastInsertRowid);
          state = "candidate";
          observations = 1;
        } else {
          locationId = Number(existing.id);
          const unchanged = existing.input_fingerprint === inputFingerprint;
          if (!unchanged) supersedeStatement.run(now, locationId, inputFingerprint);
          observations = unchanged && existing.state !== "missing" ? Number(existing.stable_observations) + 1 : 1;
          state = unchanged && (existing.state === "present" || observations >= 2) ? "present" : "candidate";
          assetId = unchanged ? existing.asset_id : null;
          updateStatement.run(
            entry.name,
            entry.size,
            entry.mtimeNs,
            entry.device,
            entry.inode,
            inputFingerprint,
            entry.date,
            entry.type,
            state,
            observations,
            generation,
            assetId,
            entry.dateSource,
            now,
            locationId
          );
        }
        if (state === "present") {
          present += 1;
          if (assetId === null) {
            enqueueStatement.run(locationId, hashSpecId, inputFingerprint, inputFingerprint, now, now, now);
          }
        } else {
          candidates += 1;
        }
      }

      const missing = this.db.prepare(`
        SELECT id FROM locations
        WHERE source_id = ? AND last_seen_generation < ? AND state != 'missing'
      `).all(this.sourceId, generation);
      this.db.prepare(`
        UPDATE locations SET state = 'missing', missing_at = ?
        WHERE source_id = ? AND last_seen_generation < ? AND state != 'missing'
      `).run(now, this.sourceId, generation);
      for (const location of missing) {
        this.db.prepare(`
          UPDATE jobs SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
            lease_token = NULL, updated_at = ?
          WHERE location_id = ? AND state IN ('queued', 'running')
        `).run(now, location.id);
      }
      this.db.prepare(`
        UPDATE sources SET generation = ?, state = 'ready', last_success_at = ?, last_error = NULL
        WHERE id = ?
      `).run(generation, now, this.sourceId);
      return { generation, candidates, present, missing: missing.length };
    });
  }

  timeline() {
    const rows = this.db.prepare(`
      SELECT locations.path, locations.name, locations.media_date AS date,
        locations.media_type AS type, locations.media_date_source AS dateSource,
        assets.media_id AS mediaId
      FROM locations
      LEFT JOIN assets ON assets.id = locations.asset_id
      WHERE locations.source_id = ? AND locations.state = 'present'
      ORDER BY media_date DESC, path ASC
    `).all(this.sourceId);
    const groups = [];
    for (const row of rows) {
      const current = groups.at(-1);
      if (!current || current.date !== row.date) groups.push({ date: row.date, items: [] });
      groups.at(-1).items.push({
        mediaId: row.mediaId,
        name: row.name,
        path: row.path,
        type: row.type,
        dateSource: row.dateSource,
      });
    }
    const source = this.db.prepare("SELECT last_success_at FROM sources WHERE id = ?").get(this.sourceId);
    return { generatedAt: source.last_success_at, itemCount: rows.length, groups };
  }

  status() {
    const source = this.db.prepare(`
      SELECT root, generation, state, scan_started_at AS scanStartedAt,
        last_success_at AS lastSuccessAt, last_error AS lastError
      FROM sources WHERE id = ?
    `).get(this.sourceId);
    const locations = Object.fromEntries(
      this.db.prepare(`
        SELECT state, count(*) AS count FROM locations WHERE source_id = ? GROUP BY state
      `).all(this.sourceId).map((row) => [row.state, Number(row.count)])
    );
    const jobs = Object.fromEntries(
      this.db.prepare("SELECT state, count(*) AS count FROM jobs GROUP BY state").all()
        .map((row) => [row.state, Number(row.count)])
    );
    return { source, locations, jobs };
  }

  claimHashJob(owner = `pid-${process.pid}`) {
    return transaction(this.db, () => {
      const now = new Date().toISOString();
      const hashSpecId = this.currentHashSpecId();
      this.db.prepare(`
        UPDATE jobs SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL,
          lease_token = NULL, updated_at = ?
        WHERE state = 'running' AND lease_expires_at <= ?
      `).run(now, now);
      const job = this.db.prepare(`
        SELECT jobs.id, jobs.location_id AS locationId, jobs.input_key AS inputKey,
          jobs.attempts, locations.path, locations.size, locations.mtime_ns AS mtimeNs,
          locations.device, locations.inode
        FROM jobs
        JOIN locations ON locations.id = jobs.location_id
        JOIN sources ON sources.id = locations.source_id
        WHERE jobs.state = 'queued' AND jobs.available_at <= ? AND locations.state = 'present'
          AND jobs.input_key = locations.input_fingerprint AND sources.state = 'ready'
          AND jobs.stage_spec_id = ?
        ORDER BY jobs.id LIMIT 1
      `).get(now, hashSpecId);
      if (!job) return null;
      const leaseToken = opaqueId("lease");
      this.db.prepare(`
        UPDATE jobs SET state = 'running', lease_owner = ?, lease_expires_at = ?,
          lease_token = ?, updated_at = ?
        WHERE id = ?
      `).run(owner, new Date(Date.now() + 30 * 60 * 1000).toISOString(), leaseToken, now, job.id);
      return {
        ...job,
        id: Number(job.id),
        locationId: Number(job.locationId),
        size: Number(job.size),
        leaseToken,
      };
    });
  }

  completeHash(job, digest) {
    const now = new Date().toISOString();
    return transaction(this.db, () => {
      const hashSpecId = this.currentHashSpecId();
      const claimed = this.db.prepare(`
        SELECT jobs.state, jobs.lease_token AS leaseToken, jobs.lease_expires_at AS leaseExpiresAt,
          jobs.stage_spec_id AS stageSpecId, jobs.location_id AS locationId,
          jobs.input_key AS inputKey, locations.state AS locationState,
          locations.input_fingerprint AS locationInputKey, locations.size
        FROM jobs JOIN locations ON locations.id = jobs.location_id
        WHERE jobs.id = ?
      `).get(job.id);
      if (
        !claimed ||
        claimed.state !== "running" ||
        claimed.leaseToken !== job.leaseToken ||
        claimed.leaseExpiresAt <= now ||
        Number(claimed.stageSpecId) !== hashSpecId
      ) return false;
      if (claimed.locationState !== "present" || claimed.locationInputKey !== claimed.inputKey) {
        this.db.prepare(`
          UPDATE jobs SET state = 'superseded', lease_owner = NULL, lease_expires_at = NULL,
            lease_token = NULL, updated_at = ?
          WHERE id = ? AND lease_token = ?
        `).run(now, job.id, job.leaseToken);
        return false;
      }
      this.db.prepare(`
        INSERT OR IGNORE INTO assets (hash_algorithm, content_hash, size, created_at, media_id)
        VALUES ('sha256', ?, ?, ?, ?)
      `).run(digest, claimed.size, now, opaqueId("med"));
      const asset = this.db.prepare(`
        SELECT id FROM assets WHERE hash_algorithm = 'sha256' AND content_hash = ? AND size = ?
      `).get(digest, claimed.size);
      this.db.prepare("UPDATE locations SET asset_id = ? WHERE id = ?").run(asset.id, claimed.locationId);
      this.db.prepare(`
        UPDATE jobs SET state = 'complete', lease_owner = NULL, lease_expires_at = NULL,
          lease_token = NULL, last_error = NULL, updated_at = ?
        WHERE id = ? AND lease_token = ?
      `).run(now, job.id, job.leaseToken);
      return true;
    });
  }

  supersedeJob(job) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE jobs SET state = 'superseded', lease_owner = NULL, lease_expires_at = NULL,
        lease_token = NULL, updated_at = ?
      WHERE id = ? AND state = 'running' AND lease_token = ? AND lease_expires_at > ?
    `).run(now, job.id, job.leaseToken, now);
  }

  failJob(job, error) {
    return transaction(this.db, () => {
      const now = new Date().toISOString();
      const claimed = this.db.prepare(`
        SELECT attempts FROM jobs
        WHERE id = ? AND state = 'running' AND lease_token = ? AND lease_expires_at > ?
      `).get(job.id, job.leaseToken, now);
      if (!claimed) return false;
      const attempts = Number(claimed.attempts) + 1;
      const failed = attempts >= MAX_JOB_ATTEMPTS;
      const delay = Math.min(60 * 60 * 1000, 1000 * (2 ** attempts));
      this.db.prepare(`
        UPDATE jobs SET state = ?, attempts = ?, available_at = ?, lease_owner = NULL,
          lease_expires_at = NULL, lease_token = NULL, last_error = ?, updated_at = ?
        WHERE id = ? AND lease_token = ?
      `).run(
        failed ? "failed" : "queued",
        attempts,
        new Date(Date.now() + delay).toISOString(),
        String(error?.message ?? error).slice(0, 1000),
        now,
        job.id,
        job.leaseToken
      );
      return true;
    });
  }
}

async function hashFile(path, signal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

export async function runHashJob(catalog, job, signal) {
  const path = resolve(catalog.root, job.path);
  if (path !== catalog.root && !path.startsWith(`${catalog.root}${sep}`)) {
    throw new Error("catalog path escapes source root");
  }
  const before = await stat(path, { bigint: true });
  const observed = {
    size: Number(before.size),
    mtimeNs: before.mtimeNs.toString(),
    device: before.dev.toString(),
    inode: before.ino.toString(),
  };
  if (fingerprint(observed) !== job.inputKey) {
    catalog.supersedeJob(job);
    return false;
  }
  const digest = await hashFile(path, signal);
  const after = await stat(path, { bigint: true });
  const afterObserved = {
    size: Number(after.size),
    mtimeNs: after.mtimeNs.toString(),
    device: after.dev.toString(),
    inode: after.ino.toString(),
  };
  if (fingerprint(afterObserved) !== job.inputKey) {
    catalog.supersedeJob(job);
    return false;
  }
  return catalog.completeHash(job, digest);
}

function json(outgoing, status, value) {
  outgoing.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  outgoing.end(`${JSON.stringify(value)}\n`);
}

export function intelligenceServer(catalog) {
  return createServer((incoming, outgoing) => {
    if (incoming.method !== "GET") return json(outgoing, 405, { error: "method not allowed" });
    const path = new URL(incoming.url, "http://intelligence.local").pathname;
    if (path === "/health/live") return json(outgoing, 200, { status: "up" });
    if (path === "/health/ready") {
      const status = catalog.status();
      const ready = status.source.lastSuccessAt !== null;
      return json(outgoing, ready ? 200 : 503, { status: ready ? status.source.state : "starting" });
    }
    if (path === "/status") return json(outgoing, 200, catalog.status());
    if (path === "/timeline") return json(outgoing, 200, catalog.timeline());
    return json(outgoing, 404, { error: "not found" });
  });
}

async function pause(milliseconds, signal) {
  try {
    await sleep(milliseconds, undefined, { signal });
    return true;
  } catch (error) {
    if (error.name === "AbortError") return false;
    throw error;
  }
}

export async function scanLoop(config, catalog, signal, watcherFactory = watchFileSystem) {
  const timers = new Map();
  let watcher = null;
  let scanRunning = false;
  let rerunRequested = false;
  let currentScan = Promise.resolve();

  const clearTimer = (name) => {
    const timer = timers.get(name);
    if (timer) clearTimeout(timer);
    timers.delete(name);
  };
  const schedule = (name, delay) => {
    if (signal.aborted) return;
    clearTimer(name);
    timers.set(name, setTimeout(() => {
      timers.delete(name);
      void requestScan();
    }, delay));
  };
  const closeWatcher = () => {
    watcher?.close();
    watcher = null;
  };
  const ensureWatcher = () => {
    if (watcher || signal.aborted) return;
    watcher = watcherFactory(config.source, { recursive: true }, () => {
      schedule("event", config.watchDebounceMs);
    });
    watcher.once("error", (error) => {
      console.error(`photo source watch failed: ${error.message}`);
      closeWatcher();
      schedule("retry", config.retryIntervalMs);
    });
  };
  const scanOnce = async () => {
    catalog.scanStarted();
    let result;
    try {
      const entries = await discoverMedia(config.source, config.sentinel);
      if (signal.aborted) return;
      result = catalog.reconcile(entries);
    } catch (error) {
      if (!signal.aborted) {
        catalog.scanFailed(error);
        console.error(`photo source scan failed: ${error.message}`);
        closeWatcher();
        clearTimer("periodic");
        schedule("retry", config.retryIntervalMs);
      }
      return;
    }
    console.log(`scan ${result.generation}: ${result.present} present, ${result.candidates} settling, ${result.missing} missing`);
    clearTimer("retry");
    schedule("periodic", config.scanIntervalMs);
    if (result.candidates > 0) {
      schedule("settle", config.settleIntervalMs);
    } else {
      clearTimer("settle");
    }
    try {
      ensureWatcher();
    } catch (error) {
      console.error(`photo source watch failed: ${error.message}`);
      closeWatcher();
      schedule("retry", config.retryIntervalMs);
    }
  };
  async function requestScan() {
    if (scanRunning) {
      rerunRequested = true;
      return currentScan;
    }
    currentScan = (async () => {
      scanRunning = true;
      do {
        rerunRequested = false;
        await scanOnce();
      } while (rerunRequested && !signal.aborted);
      scanRunning = false;
    })();
    return currentScan;
  }

  const aborted = new Promise((resolvePromise) => {
    if (signal.aborted) resolvePromise();
    else signal.addEventListener("abort", resolvePromise, { once: true });
  });
  void requestScan();
  await aborted;
  for (const name of timers.keys()) clearTimer(name);
  closeWatcher();
  await currentScan;
}

async function jobLoop(catalog, signal) {
  while (!signal.aborted) {
    const job = catalog.claimHashJob();
    if (!job) {
      if (!(await pause(500, signal))) break;
      continue;
    }
    try {
      await runHashJob(catalog, job, signal);
    } catch (error) {
      if (signal.aborted && error.name === "AbortError") break;
      catalog.failJob(job, error);
    }
  }
}

async function main() {
  process.umask(0o077);
  const config = parseArgs(process.argv.slice(2));
  await mkdir(config.state, { recursive: true, mode: 0o700 });
  await chmod(config.state, 0o700);
  const databasePath = join(config.state, "catalog.sqlite");
  const catalog = new Catalog(databasePath, config.source, config.sentinel);
  await chmod(databasePath, 0o600);
  const abort = new AbortController();
  const server = intelligenceServer(catalog);
  server.listen(config.port, config.host, () => {
    console.log(`photo intelligence listening on http://${config.host}:${config.port}`);
  });
  const loops = [scanLoop(config, catalog, abort.signal), jobLoop(catalog, abort.signal)];
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    abort.abort();
    await Promise.all([
      ...loops,
      new Promise((resolvePromise, reject) => {
        server.close((error) => error ? reject(error) : resolvePromise());
      }),
    ]);
    catalog.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
