const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'scans.db');

let db = null;

// Initialize database
async function initDatabase() {
    const SQL = await initSqlJs();

    // Load existing database or create new one
    let buffer;
    try {
        buffer = fs.readFileSync(DB_PATH);
    } catch (err) {
        // Database doesn't exist yet
        buffer = null;
    }

    db = new SQL.Database(buffer);

    // Create schema
    db.run(`
    CREATE TABLE IF NOT EXISTS scan_status (
      reservation_id INTEGER PRIMARY KEY,
      total_persons INTEGER NOT NULL,
      scanned_persons INTEGER DEFAULT 0,
      remaining_persons INTEGER NOT NULL,
      last_scan_at TEXT,
      reservation_name TEXT,
      reservation_date TEXT,
      start_time TEXT,
      facility_id INTEGER,
      tour_leg TEXT
    );

    CREATE TABLE IF NOT EXISTS scan_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      reservation_id INTEGER NOT NULL,
      persons_entered INTEGER NOT NULL,
      device_id TEXT,
      reservation_name TEXT,
      contact_name TEXT,
      forced INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_scan_history_timestamp 
      ON scan_history(timestamp DESC);
    
    CREATE INDEX IF NOT EXISTS idx_scan_history_reservation 
      ON scan_history(reservation_id);

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL
    );
  `);

    // Seed default users if empty
    try {
        const result = db.exec("SELECT count(*) FROM users");
        const count = result[0].values[0][0];

        if (count === 0) {
            console.log('Eerste keer opstarten: standaard gebruikers aanmaken...');
            const adminPass = crypto.randomBytes(16).toString('hex');
            const staffPass = crypto.randomBytes(16).toString('hex');

            const adminHash = bcrypt.hashSync(adminPass, 10);
            const staffHash = bcrypt.hashSync(staffPass, 10);

            db.run("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", ['admin', adminHash, 'admin']);
            db.run("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", ['medewerker', staffHash, 'medewerker']);

            console.log('═══════════════════════════════════════════');
            console.log('  EERSTE KEER: Noteer deze wachtwoorden!');
            console.log(`  admin:       ${adminPass}`);
            console.log(`  medewerker:  ${staffPass}`);
            console.log('═══════════════════════════════════════════');
        }
    } catch (e) {
        console.error('Error seeding users:', e);
    }

    saveDatabase();

    // Migration: add contact_name to scan_history if missing
    try {
        db.run("ALTER TABLE scan_history ADD COLUMN contact_name TEXT");
    } catch (e) {
        // Column already exists or table doesn't exist yet
    }

    // Migration: add tour_leg to scan_status if missing
    try {
        db.run("ALTER TABLE scan_status ADD COLUMN tour_leg TEXT");
    } catch (e) {
        // Column already exists or table doesn't exist yet
    }

    console.log('✓ Database initialized');
}

// Save database to disk
function saveDatabase() {
    if (db) {
        const data = db.export();
        fs.writeFileSync(DB_PATH, data);
    }
}

// Helper to execute query and return results
function query(sql, params = []) {
    if (!db) throw new Error('Database not initialized');
    const stmt = db.prepare(sql);
    stmt.bind(params);

    const results = [];
    while (stmt.step()) {
        results.push(stmt.getAsObject());
    }
    stmt.free();

    return results;
}

// Helper to execute update/insert
function run(sql, params = []) {
    if (!db) throw new Error('Database not initialized');
    db.run(sql, params);
    saveDatabase();
}

// Database operations
const statements = {
    getScanStatus: (reservationId) => {
        const results = query(
            'SELECT * FROM scan_status WHERE reservation_id = ?',
            [reservationId]
        );
        return results[0] || null;
    },

    upsertScanStatus: (
        reservationId, totalPersons, scannedPersons,
        remainingPersons, lastScanAt, reservationName,
        reservationDate, startTime, facilityId, tourLeg
    ) => {
        // Check if exists
        const existing = statements.getScanStatus(reservationId);

        if (existing) {
            run(
                `UPDATE scan_status SET 
          total_persons = ?,
          scanned_persons = ?,
          remaining_persons = ?,
          last_scan_at = ?,
          tour_leg = ?
        WHERE reservation_id = ?`,
                [totalPersons, scannedPersons, remainingPersons, lastScanAt, tourLeg, reservationId]
            );
        } else {
            run(
                `INSERT INTO scan_status (
          reservation_id, total_persons, scanned_persons, 
          remaining_persons, last_scan_at, reservation_name,
          reservation_date, start_time, facility_id, tour_leg
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    reservationId, totalPersons, scannedPersons,
                    remainingPersons, lastScanAt, reservationName,
                    reservationDate, startTime, facilityId, tourLeg
                ]
            );
        }
    },

    getAllScanStatus: (date) => {
        return query(
            'SELECT * FROM scan_status WHERE reservation_date = ? ORDER BY start_time ASC',
            [date]
        );
    },

    getScanStatusByFacility: (date, facilityId) => {
        return query(
            'SELECT * FROM scan_status WHERE reservation_date = ? AND facility_id = ? ORDER BY start_time ASC',
            [date, facilityId]
        );
    },

    addScanHistory: (timestamp, reservationId, personsEntered, deviceId, reservationName, contactName, forced) => {
        run(
            `INSERT INTO scan_history (
        timestamp, reservation_id, persons_entered, 
        device_id, reservation_name, contact_name, forced
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [timestamp, reservationId, personsEntered, deviceId, reservationName, contactName, forced ? 1 : 0]
        );
    },

    getScanHistory: () => {
        return query(
            'SELECT * FROM scan_history ORDER BY timestamp DESC LIMIT 100'
        );
    },

    getScanHistoryById: (id) => {
        const results = query('SELECT * FROM scan_history WHERE id = ?', [id]);
        return results[0] || null;
    },

    deleteScanHistory: (id) => {
        run('DELETE FROM scan_history WHERE id = ?', [id]);
    },

    clearOldScans: () => {
        run(`DELETE FROM scan_status WHERE reservation_date < date('now', '-1 day')`);
    },

    getUser: (username) => {
        // sql.js return structure handling inside query() wrapper
        const results = query('SELECT * FROM users WHERE username = ?', [username]);
        return results[0] || null;
    },

    getAllUsers: () => {
        return query('SELECT id, username, role FROM users ORDER BY username ASC');
    },

    createUser: (username, passwordHash, role) => {
        run(
            'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
            [username, passwordHash, role]
        );
    },

    deleteUser: (id) => {
        run('DELETE FROM users WHERE id = ?', [id]);
    },

    updateUserRole: (id, role) => {
        run('UPDATE users SET role = ? WHERE id = ?', [role, id]);
    },

    updateUserPassword: (id, passwordHash) => {
        run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
    },

    getUserById: (id) => {
        const results = query('SELECT id, username, role FROM users WHERE id = ?', [id]);
        return results[0] || null;
    }
};

module.exports = {
    initDatabase,
    statements,
    saveDatabase
};
