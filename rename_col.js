require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.SUPABASE_DATABASE_URL });

async function renameColumn() {
    try {
        console.log("Renaming column in Supabase...");
        await pool.query('ALTER TABLE interlight_catalog_raw RENAME COLUMN referencia_completa TO produtos;');
        console.log("Column successfully renamed to 'produtos'.");
    } catch (e) {
        if (e.message.includes('does not exist')) {
            console.log("Column might have already been renamed or does not exist. Error:", e.message);
        } else {
            console.error("Error executing ALTER TABLE:", e.message);
        }
    } finally {
        await pool.end();
    }
}

renameColumn();
