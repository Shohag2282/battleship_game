// Fix script - adds missing columns to existing users table
const db = require('./config/db');

async function fix() {
    console.log("Running DB fix...");
    
    try {
        // Check current columns
        const [cols] = await db.query("SHOW COLUMNS FROM users");
        const colNames = cols.map(c => c.Field);
        console.log("Current columns:", colNames);

        // Add missing columns
        if (!colNames.includes('games_played')) {
            await db.query("ALTER TABLE users ADD COLUMN games_played INT DEFAULT 0");
            console.log("✅ Added games_played column");
        } else {
            console.log("ℹ️  games_played column already exists");
        }

        if (!colNames.includes('wins')) {
            await db.query("ALTER TABLE users ADD COLUMN wins INT DEFAULT 0");
            console.log("✅ Added wins column");
        } else {
            console.log("ℹ️  wins column already exists");
        }

        if (!colNames.includes('losses')) {
            await db.query("ALTER TABLE users ADD COLUMN losses INT DEFAULT 0");
            console.log("✅ Added losses column");
        } else {
            console.log("ℹ️  losses column already exists");
        }

        // Verify game_rooms has winner_name
        try {
            const [grCols] = await db.query("SHOW COLUMNS FROM game_rooms");
            const grColNames = grCols.map(c => c.Field);
            if (!grColNames.includes('winner_name')) {
                await db.query("ALTER TABLE game_rooms ADD COLUMN winner_name VARCHAR(255)");
                console.log("✅ Added winner_name column to game_rooms");
            } else {
                console.log("ℹ️  winner_name column already exists in game_rooms");
            }
        } catch(e) {
            console.log("game_rooms table may not exist yet - will be created on server start");
        }

        // Show current users
        const [users] = await db.query("SELECT id, username, score, games_played, wins, losses FROM users");
        console.log("\nCurrent users in DB:");
        console.table(users);

        console.log("\n✅ DB fix complete! Restart the server now.");
    } catch (err) {
        console.error("❌ Fix error:", err.message);
    }
    process.exit(0);
}

fix();
