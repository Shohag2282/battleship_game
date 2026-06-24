const fs = require('fs');
const path = require('path');

let logContent = `=== BATTLESHIP DIAGNOSTIC REPORT ===
Date: ${new Date().toISOString()}

`;

// 1. Check folder path
logContent += `Directory: ${__dirname}\n\n`;

// 2. Check dependencies
const deps = ['express', 'cors', 'mysql2', 'socket.io'];
logContent += `Checking Node Modules:\n`;
for (let dep of deps) {
    try {
        require(dep);
        logContent += `- ${dep}: OK\n`;
    } catch (e) {
        logContent += `- ${dep}: FAILED (${e.message})\n`;
    }
}
logContent += `\n`;

// 3. Test Database Connection
logContent += `Checking MySQL Database Connection (host: 127.0.0.1, user: root):\n`;
try {
    const mysql = require('mysql2');
    const pool = mysql.createPool({
        host: '127.0.0.1',
        user: 'root',
        password: '',
        database: 'battleship_db'
    }).promise();

    pool.query("SELECT 1")
        .then(async () => {
            logContent += `- Connection: SUCCESS\n`;
            try {
                const [rows] = await pool.query("SHOW TABLES");
                const tables = rows.map(r => Object.values(r)[0]);
                logContent += `- Tables found: ${tables.join(', ')}\n`;
            } catch (e) {
                logContent += `- Query error: ${e.message}\n`;
            }
            writeLog();
        })
        .catch(err => {
            logContent += `- Connection: FAILED (${err.message})\n`;
            writeLog();
        });
} catch (e) {
    logContent += `- mysql2 module error: ${e.message}\n`;
    writeLog();
}

function writeLog() {
    // 4. Test Port 5050 binding
    logContent += `\nChecking Port 5050 availability:\n`;
    const http = require('http');
    const tempServer = http.createServer();
    tempServer.once('error', (err) => {
        logContent += `- Port 5050: BLOCKED (Error: ${err.code})\n`;
        saveReport();
    });
    tempServer.once('listening', () => {
        logContent += `- Port 5050: FREE\n`;
        tempServer.close();
        saveReport();
    });
    tempServer.listen(5050);
}

function saveReport() {
    try {
        fs.writeFileSync(path.join(__dirname, '../diagnose_result.txt'), logContent);
        console.log("\n==============================================");
        console.log("Diagnostic complete! Results written to diagnose_result.txt");
        console.log("==============================================\n");
        process.exit(0);
    } catch (e) {
        console.error("Failed to write log:", e);
        process.exit(1);
    }
}
