// mysql2 gives us a connection pool so multiple requests don't block each other
const mysql = require('mysql2');

const pool = mysql.createPool({
    host: '127.0.0.1',
    user: 'root',       // MySQL username (usually 'root' for local dev)
    password: '',       // leave blank if using XAMPP without a password
    database: 'battleship_db',
    waitForConnections: true,
    connectionLimit: 10,  // max 10 simultaneous DB connections
    queueLimit: 0
});

// export with promise support so we can use async/await in server.js
module.exports = pool.promise();