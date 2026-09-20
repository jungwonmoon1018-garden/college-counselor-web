// ec-strength-schema.js — the activity-strength tables and prepared statements.
// Moved out of ec-strength-vectorizer.js on 2026-09-20, which re-exports them
// so its importers are unchanged.
// ─── Schema ─────────────────────────────────────────────────
export function initECStrengthTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ec_strength_vectors (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL,
      ec_name TEXT NOT NULL,
      description TEXT,

      dedication REAL DEFAULT 0,
      achievement REAL DEFAULT 0,
      leadership REAL DEFAULT 0,
      prestige REAL DEFAULT 0,
      prestige_source TEXT,
      major_spike REAL DEFAULT 0,
      narrative_fit REAL DEFAULT 0,
      tier_label TEXT,

      hours_per_week REAL,
      weeks_per_year REAL,
      years_active REAL,
      lifetime_hours REAL,

      is_overridden INTEGER DEFAULT 0,
      override_json TEXT,

      reasoning_json TEXT,
      file_refs_json TEXT,
      narrative_version_id TEXT,

      computed_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(student_id, ec_name)
    );
    CREATE INDEX IF NOT EXISTS idx_ec_strength_student
      ON ec_strength_vectors(student_id, ec_name);
    CREATE INDEX IF NOT EXISTS idx_ec_strength_tier
      ON ec_strength_vectors(student_id, tier_label);

    CREATE TABLE IF NOT EXISTS ec_attachments (
      id TEXT PRIMARY KEY,
      student_id TEXT,
      ec_name TEXT,
      filename TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      storage_path TEXT NOT NULL,
      extracted_text TEXT,
      extracted_text_hash TEXT,
      extracted_chars INTEGER DEFAULT 0,
      extraction_status TEXT DEFAULT 'pending',
      extraction_error TEXT,
      uploaded_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ec_attachments_student_ec
      ON ec_attachments(student_id, ec_name);
  `);

  // In-place migration — older installs may not have prestige / prestige_source.
  const cols = db.prepare(`PRAGMA table_info(ec_strength_vectors)`).all().map((r) => r.name);
  if (!cols.includes("prestige")) {
    db.exec(`ALTER TABLE ec_strength_vectors ADD COLUMN prestige REAL DEFAULT 0`);
  }
  if (!cols.includes("prestige_source")) {
    db.exec(`ALTER TABLE ec_strength_vectors ADD COLUMN prestige_source TEXT`);
    // Mark pre-existing rows so callers can distinguish "never researched" from
    // "researched as zero".
    db.exec(`UPDATE ec_strength_vectors SET prestige_source = 'legacy' WHERE prestige_source IS NULL`);
  }
  if (!cols.includes("major_spike")) {
    db.exec(`ALTER TABLE ec_strength_vectors ADD COLUMN major_spike REAL DEFAULT 0`);
  }
}

export function prepareECStrengthStatements(db) {
  return {
    upsert: db.prepare(`
      INSERT INTO ec_strength_vectors
        (id, student_id, ec_name, description,
         dedication, achievement, leadership, prestige, prestige_source, major_spike,
         narrative_fit, tier_label,
         hours_per_week, weeks_per_year, years_active, lifetime_hours,
         is_overridden, override_json,
         reasoning_json, file_refs_json, narrative_version_id,
         computed_at, updated_at)
      VALUES (?,?,?,?, ?,?,?,?,?, ?,?, ?,?,?,?, ?,?, ?,?,?,?,
              datetime('now'), datetime('now'))
      ON CONFLICT(student_id, ec_name) DO UPDATE SET
        description = excluded.description,
        dedication = excluded.dedication,
        achievement = excluded.achievement,
        leadership = excluded.leadership,
        prestige = excluded.prestige,
        prestige_source = excluded.prestige_source,
        major_spike = excluded.major_spike,
        narrative_fit = excluded.narrative_fit,
        tier_label = excluded.tier_label,
        hours_per_week = excluded.hours_per_week,
        weeks_per_year = excluded.weeks_per_year,
        years_active = excluded.years_active,
        lifetime_hours = excluded.lifetime_hours,
        is_overridden = excluded.is_overridden,
        override_json = excluded.override_json,
        reasoning_json = excluded.reasoning_json,
        file_refs_json = excluded.file_refs_json,
        narrative_version_id = excluded.narrative_version_id,
        updated_at = datetime('now')
    `),
    getByStudent: db.prepare(`
      SELECT * FROM ec_strength_vectors
      WHERE student_id = ?
      ORDER BY
        CASE tier_label
          WHEN 'tier_1_distinctive' THEN 1
          WHEN 'tier_2_strong' THEN 2
          WHEN 'tier_3_developing' THEN 3
          WHEN 'tier_4_foundational' THEN 4
          ELSE 5
        END,
        ec_name ASC
    `),
    getByStudentAndName: db.prepare(`
      SELECT * FROM ec_strength_vectors
      WHERE student_id = ? AND ec_name = ?
    `),
    deleteByStudentAndName: db.prepare(`
      DELETE FROM ec_strength_vectors
      WHERE student_id = ? AND ec_name = ?
    `),
    applyOverride: db.prepare(`
      UPDATE ec_strength_vectors
      SET dedication = COALESCE(?, dedication),
          achievement = COALESCE(?, achievement),
          leadership = COALESCE(?, leadership),
          prestige = COALESCE(?, prestige),
          prestige_source = CASE WHEN ? IS NOT NULL THEN 'override' ELSE prestige_source END,
          major_spike = COALESCE(?, major_spike),
          narrative_fit = COALESCE(?, narrative_fit),
          tier_label = ?,
          is_overridden = 1,
          override_json = ?,
          updated_at = datetime('now')
      WHERE student_id = ? AND ec_name = ?
    `),

    // Attachment statements
    insertAttachment: db.prepare(`
      INSERT INTO ec_attachments
        (id, student_id, ec_name, filename, mime_type, size_bytes,
         storage_path, extracted_text, extracted_text_hash, extracted_chars,
         extraction_status, extraction_error, uploaded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    `),
    getAttachmentById: db.prepare(`SELECT * FROM ec_attachments WHERE id = ?`),
    getAttachmentsForStudent: db.prepare(`
      SELECT * FROM ec_attachments WHERE student_id = ? ORDER BY uploaded_at DESC
    `),
    getAttachmentsForEC: db.prepare(`
      SELECT * FROM ec_attachments
      WHERE student_id = ? AND ec_name = ? AND extraction_status = 'ok'
      ORDER BY uploaded_at ASC
    `),
    linkAttachmentToEC: db.prepare(`
      UPDATE ec_attachments SET ec_name = ? WHERE id = ? AND student_id = ?
    `),
  };
}
