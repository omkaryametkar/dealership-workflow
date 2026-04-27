var mysql = require('mysql');

// Create connection to MySQL
var con = mysql.createConnection({
  host: "127.0.0.1",
  user: "root",
  password: "root@123",
  database: "booking"
});

// Connect to database
con.connect(function (err) {
  if (err) throw err;
  console.log("Connected to booking database");

  // SQL query to create booking_cancellations table
  var sql = `
    CREATE TABLE IF NOT EXISTS booking_cancellations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id VARCHAR(50),
      booking_id INT,
      reason TEXT,
      bank_details TEXT,
      cancelled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  // Execute query
  con.query(sql, function (err, result) {
    if (err) throw err;
    console.log("Table 'booking_cancellations' created or already exists");

    con.end(); // close connection
  });
});