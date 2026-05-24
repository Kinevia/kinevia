/**
 * Migration script: Neon → Clever Cloud HDS PostgreSQL
 *
 * Usage:
 *   CLEVER_CLOUD_DB_URL=REDACTED/db node scripts/migrate-to-clevercloud.js');
  process.exit(1);
}

const sourcePool = new Pool({
  connectionString: NEON_URL,
  ssl: { rejectUnauthorized: false }
});

const targetPool = new Pool({
  connectionString: CC_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  console.log('=== MonKiné: Neon → Clever Cloud HDS Migration ===\n');

  const source = await sourcePool.connect();
  const target = await targetPool.connect();

  try {
    // -------------------------------------------------------
    // STEP 1: Verify source connectivity
    // -------------------------------------------------------
    console.log('Step 1: Connecting to source (Neon)...');
    const srcVersion = await source.query('SELECT version()');
    console.log('  Source:', srcVersion.rows[0].version.split(' ').slice(0, 2).join(' '));

    // -------------------------------------------------------
    // STEP 2: Verify target connectivity
    // -------------------------------------------------------
    console.log('Step 2: Connecting to target (Clever Cloud HDS)...');
    const tgtVersion = await target.query('SELECT version()');
    console.log('  Target:', tgtVersion.rows[0].version.split(' ').slice(0, 2).join(' '));

    // -------------------------------------------------------
    // STEP 3: Export schema from source
    // -------------------------------------------------------
    console.log('\nStep 3: Reading source tables...');
    const tables = ['kines', 'patients', 'exercices', 'programmes', 'programme_exercices',
                    'seances', 'seance_exercices', 'bilans', 'zones_corporelles',
                    'users', '_migrations'];

    const counts = {};
    for (const t of tables) {
      try {
        const r = await source.query(`SELECT COUNT(*) FROM ${t}`);
        counts[t] = parseInt(r.rows[0].count);
        console.log(`  ${t}: ${counts[t]} rows`);
      } catch (e) {
        counts[t] = 0;
        console.log(`  ${t}: table not found (skipping)`);
      }
    }

    // -------------------------------------------------------
    // STEP 4: Create schema on target (run all migrations)
    // -------------------------------------------------------
    console.log('\nStep 4: Creating schema on Clever Cloud...');

    // Run the migrate.js logic against the target DB
    process.env.DATABASE_URL = CC_URL;
    // We'll create schema directly here instead of calling migrate.js
    // to avoid cross-pool issues

    await target.query('BEGIN');

    // _migrations table
    await target.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // users table (Polsia core)
    await target.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        password_hash VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        stripe_subscription_id VARCHAR(255),
        subscription_status VARCHAR(50),
        subscription_plan VARCHAR(255),
        subscription_expires_at TIMESTAMPTZ,
        subscription_updated_at TIMESTAMPTZ
      )
    `);
    await target.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users (LOWER(email))`);
    await target.query(`CREATE INDEX IF NOT EXISTS users_stripe_subscription_id_idx ON users (stripe_subscription_id)`);

    // kines
    await target.query(`
      CREATE TABLE IF NOT EXISTS kines (
        id SERIAL PRIMARY KEY,
        nom VARCHAR(255) NOT NULL,
        prenom VARCHAR(255),
        email VARCHAR(255) NOT NULL,
        mot_de_passe_hash VARCHAR(255) NOT NULL,
        cabinet VARCHAR(255),
        telephone VARCHAR(50),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await target.query(`CREATE UNIQUE INDEX IF NOT EXISTS kines_email_unique_idx ON kines (LOWER(email))`);

    // patients
    await target.query(`
      CREATE TABLE IF NOT EXISTS patients (
        id SERIAL PRIMARY KEY,
        kine_id INTEGER NOT NULL REFERENCES kines(id) ON DELETE CASCADE,
        nom VARCHAR(255) NOT NULL,
        prenom VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        telephone VARCHAR(50),
        pathologie TEXT,
        notes TEXT,
        lien_unique VARCHAR(64) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await target.query(`CREATE UNIQUE INDEX IF NOT EXISTS patients_lien_unique_idx ON patients (lien_unique)`);
    await target.query(`CREATE INDEX IF NOT EXISTS patients_kine_id_idx ON patients (kine_id)`);

    // exercices
    await target.query(`
      CREATE TABLE IF NOT EXISTS exercices (
        id SERIAL PRIMARY KEY,
        nom VARCHAR(255) NOT NULL,
        zone_corporelle VARCHAR(50) NOT NULL,
        description TEXT,
        image_url TEXT,
        video_url TEXT,
        est_personnalise BOOLEAN DEFAULT false,
        kine_id INTEGER REFERENCES kines(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        series_recommandees INTEGER DEFAULT 3,
        repetitions_recommandees VARCHAR(50) DEFAULT '10',
        muscles TEXT
      )
    `);
    await target.query(`CREATE INDEX IF NOT EXISTS exercices_zone_idx ON exercices (zone_corporelle)`);
    await target.query(`CREATE INDEX IF NOT EXISTS exercices_kine_id_idx ON exercices (kine_id)`);

    // programmes
    await target.query(`
      CREATE TABLE IF NOT EXISTS programmes (
        id SERIAL PRIMARY KEY,
        kine_id INTEGER NOT NULL REFERENCES kines(id) ON DELETE CASCADE,
        patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        titre VARCHAR(255) NOT NULL,
        date_debut DATE,
        date_fin DATE,
        notes TEXT,
        actif BOOLEAN DEFAULT true,
        frequence_semaine INTEGER,
        duree_semaines INTEGER,
        statut VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await target.query(`CREATE INDEX IF NOT EXISTS programmes_patient_id_idx ON programmes (patient_id)`);
    await target.query(`CREATE INDEX IF NOT EXISTS programmes_kine_id_idx ON programmes (kine_id)`);

    // programme_exercices
    await target.query(`
      CREATE TABLE IF NOT EXISTS programme_exercices (
        id SERIAL PRIMARY KEY,
        programme_id INTEGER NOT NULL REFERENCES programmes(id) ON DELETE CASCADE,
        exercice_id INTEGER NOT NULL REFERENCES exercices(id) ON DELETE CASCADE,
        series INTEGER DEFAULT 3,
        repetitions VARCHAR(50) DEFAULT '10',
        duree_secondes INTEGER,
        instructions TEXT,
        ordre INTEGER DEFAULT 0
      )
    `);
    await target.query(`CREATE INDEX IF NOT EXISTS pe_programme_id_idx ON programme_exercices (programme_id)`);

    // seances
    await target.query(`
      CREATE TABLE IF NOT EXISTS seances (
        id SERIAL PRIMARY KEY,
        programme_id INTEGER NOT NULL REFERENCES programmes(id) ON DELETE CASCADE,
        patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        date DATE NOT NULL DEFAULT CURRENT_DATE,
        completee BOOLEAN DEFAULT false,
        douleur_score INTEGER,
        notes_patient TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        difficulte VARCHAR(20)
      )
    `);
    await target.query(`CREATE INDEX IF NOT EXISTS seances_patient_id_idx ON seances (patient_id)`);
    await target.query(`CREATE INDEX IF NOT EXISTS seances_programme_id_idx ON seances (programme_id)`);

    // seance_exercices
    await target.query(`
      CREATE TABLE IF NOT EXISTS seance_exercices (
        id SERIAL PRIMARY KEY,
        seance_id INTEGER NOT NULL REFERENCES seances(id) ON DELETE CASCADE,
        exercice_id INTEGER NOT NULL REFERENCES exercices(id) ON DELETE CASCADE,
        complete BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await target.query(`CREATE INDEX IF NOT EXISTS se_seance_id_idx ON seance_exercices (seance_id)`);

    // bilans
    await target.query(`
      CREATE TABLE IF NOT EXISTS bilans (
        id SERIAL PRIMARY KEY,
        kine_id INTEGER NOT NULL REFERENCES kines(id) ON DELETE CASCADE,
        patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        douleur_initiale INTEGER,
        mobilite_initiale VARCHAR(255),
        objectifs TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        type VARCHAR(50) DEFAULT 'initial',
        date_bilan DATE DEFAULT CURRENT_DATE,
        observations TEXT,
        mesures TEXT
      )
    `);
    await target.query(`CREATE INDEX IF NOT EXISTS bilans_patient_id_idx ON bilans (patient_id)`);
    await target.query(`CREATE INDEX IF NOT EXISTS bilans_kine_id_idx ON bilans (kine_id)`);

    // zones_corporelles
    await target.query(`
      CREATE TABLE IF NOT EXISTS zones_corporelles (
        id SERIAL PRIMARY KEY,
        nom VARCHAR(50) NOT NULL UNIQUE,
        label_fr VARCHAR(100) NOT NULL
      )
    `);

    await target.query('COMMIT');
    console.log('  Schema created successfully.');

    // -------------------------------------------------------
    // STEP 5: Copy data table by table (ordered for FK integrity)
    // -------------------------------------------------------
    console.log('\nStep 5: Copying data...');
    const copyOrder = [
      'zones_corporelles',
      'kines',
      'patients',
      'exercices',
      'programmes',
      'programme_exercices',
      'seances',
      'seance_exercices',
      'bilans',
      'users',
      '_migrations'
    ];

    for (const table of copyOrder) {
      if (!counts[table] || counts[table] === 0) {
        console.log(`  ${table}: skipped (empty)`);
        continue;
      }

      // Read all rows from source
      const rows = await source.query(`SELECT * FROM ${table}`);
      if (rows.rows.length === 0) {
        console.log(`  ${table}: 0 rows`);
        continue;
      }

      // Check if target already has data (idempotency)
      const tgtCount = await target.query(`SELECT COUNT(*) FROM ${table}`);
      if (parseInt(tgtCount.rows[0].count) > 0) {
        console.log(`  ${table}: already has data, skipping (${tgtCount.rows[0].count} rows)`);
        continue;
      }

      // Insert in batches of 100
      const cols = Object.keys(rows.rows[0]);
      const batchSize = 100;
      let inserted = 0;

      await target.query('BEGIN');
      for (let i = 0; i < rows.rows.length; i += batchSize) {
        const batch = rows.rows.slice(i, i + batchSize);
        for (const row of batch) {
          const values = cols.map((c, idx) => `$${idx + 1}`).join(', ');
          const data = cols.map(c => row[c]);
          await target.query(
            `INSERT INTO ${table} (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${values}) ON CONFLICT DO NOTHING`,
            data
          );
          inserted++;
        }
      }
      await target.query('COMMIT');

      // Reset sequence to max(id) + 1 to avoid conflicts
      if (cols.includes('id')) {
        try {
          await target.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM ${table}`);
        } catch (e) {
          // sequence reset not critical, log and continue
          console.warn(`  Warning: could not reset sequence for ${table}: ${e.message}`);
        }
      }

      console.log(`  ${table}: ${inserted} rows copied`);
    }

    // -------------------------------------------------------
    // STEP 6: Verify counts
    // -------------------------------------------------------
    console.log('\nStep 6: Verifying data integrity...');
    let allOk = true;
    for (const table of copyOrder) {
      if (!counts[table]) continue;
      const tgtCount = await target.query(`SELECT COUNT(*) FROM ${table}`);
      const tgt = parseInt(tgtCount.rows[0].count);
      const src = counts[table];
      const ok = tgt >= src;
      if (!ok) allOk = false;
      console.log(`  ${table}: src=${src} tgt=${tgt} ${ok ? '✓' : '✗ MISMATCH!'}`);
    }

    if (allOk) {
      console.log('\n✓ Migration complete. All row counts match.');
    } else {
      console.error('\n✗ Migration has mismatches. Review above before switching DATABASE_URL.');
      process.exit(1);
    }

  } finally {
    source.release();
    target.release();
    await sourcePool.end();
    await targetPool.end();
  }
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
