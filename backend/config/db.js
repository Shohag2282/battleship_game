// mysql2 gives us a connection pool so multiple requests don't block each other
const mysql = require('mysql2');

const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',       // MySQL username (usually 'root' for local dev)
    password: process.env.DB_PASSWORD || '',       // leave blank if using XAMPP without a password
    database: process.env.DB_NAME || 'battleship_db',
    port: process.env.DB_PORT || 3306,
    ssl: process.env.DB_HOST ? { rejectUnauthorized: false } : undefined,
    waitForConnections: true,
    connectionLimit: 10,  // max 10 simultaneous DB connections
    queueLimit: 0
});

// export with promise support so we can use async/await in server.js
module.exports = pool.promise();