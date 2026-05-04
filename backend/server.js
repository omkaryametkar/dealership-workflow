const express = require("express");
const cors = require("cors");
const path = require("path");
const mysql = require("mysql2");
const multer = require("multer");
const PDFDocument = require("pdfkit");
const app = express();
const fs = require("fs");
const PORT = process.env.PORT || 3001;

// ✅ Serve files from backend folder
app.use(express.static(__dirname));
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}
// ✅ Root route (ONLY ONE)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "login.html")); // or login.html
});

// ✅ Test route
app.get("/test", (req, res) => {
  res.send("Test route working");
});

// ✅ API test
app.get("/api", (req, res) => {
  res.send("✅ API is working");
});



/* ------------ MIDDLEWARE ------------ */
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));



const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});


console.log("✅ MySQL Pool Connected");
// ---------------- FILE UPLOAD CONFIG ----------------
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    const cleanName = file.originalname.replace(/\s+/g, "_");  
    const uniqueName = Date.now() + "_" + cleanName;
    cb(null, uniqueName);
}

});

const upload = multer({ storage: storage });

// allow browser to access uploaded files
app.use("/uploads", express.static("uploads"));




app.post("/login", (req, res) => {
  const { email, password, dept } = req.body;

  const sql = `
    SELECT * FROM users 
    WHERE email = ? AND password = ? AND department = ?
  `;

  db.query(sql, [email, password, dept], (err, result) => {
    if (err) {
      console.error(err);
      return res.json({ success: false });
    }

    if (result.length > 0) {
      res.json({
        success: true,
        dept: result[0].department, // ✅ FIXED
        role: result[0].role
      });
    } else {
      res.json({ success: false });
    }
  });
});


app.get("/api/bookings", (req, res) => {

const sql = `
SELECT 
  b.booking_id,
  b.customer_id,
  b.customer_name,
  b.mobile_number,
  b.vehicle_model,
  b.booking_date,
  b.booking_amount,
  b.total_amount,
  b.booking_status,

  MAX(d.aadhaar_file) AS aadhaar_file,
  MAX(d.pan_file) AS pan_file,
  MAX(d.receipt_file) AS receipt_file,

  MAX(c.reason) AS cancel_reason,
  MAX(c.bank_details) AS cancel_bank,

  /* ⭐ TOTAL PAID FROM PAYMENT TABLE */
  (
    SELECT IFNULL(SUM(pd.amount_paid),0)
    FROM payment_details pd
    WHERE pd.booking_id = b.booking_id
  ) AS total_paid,

  CASE
    WHEN b.booking_status = 'Cancelled' THEN 'Pending'
    ELSE COALESCE(MAX(pr.status), 'Pending')
  END AS payment_status,

  COALESCE(
    MAX(pr.remaining_amount),
    (b.total_amount - b.booking_amount)
  ) AS remaining_amount

FROM bookings b

LEFT JOIN payment_refer pr
  ON b.booking_id = pr.booking_id

LEFT JOIN booking_documents d
  ON b.booking_id = d.booking_id

LEFT JOIN booking_cancellations c
  ON b.booking_id = c.booking_id

GROUP BY 
  b.booking_id,
  b.customer_id,
  b.customer_name,
  b.mobile_number,
  b.vehicle_model,
  b.booking_date,
  b.booking_amount,
  b.total_amount,
  b.booking_status

ORDER BY b.booking_id DESC
`;

db.query(sql, (err, result) => {
  if (err) {
    console.log("❌ /api/bookings error:", err);
    return res.status(500).json([]);
  }

  res.json(result);
});

});
app.post(
  "/api/add-booking",
  upload.fields([
    { name: "aadhaar_file", maxCount: 1 },
    { name: "pan_file", maxCount: 1 },
    { name: "receipt_file", maxCount: 1 }
  ]),
  (req, res) => {

    try {
      const data = req.body || {};

      // ⭐ FILES SAFE CHECK
      const aadhaarFile = req.files?.aadhaar_file?.[0]?.filename || null;
      const panFile = req.files?.pan_file?.[0]?.filename || null;
      const receiptFile = req.files?.receipt_file?.[0]?.filename || null;

      // ⭐ INSERT BOOKING
      const sql = `
        INSERT INTO bookings 
        (customer_id, customer_name, mobile_number, vehicle_model, booking_date, booking_amount, total_amount, booking_status)
        VALUES (?,?,?,?,?,?,?,?)
      `;

      db.query(sql, [
        data.customer_id,
        data.customer_name,
        data.mobile_number,
        data.vehicle_model,
        data.booking_date,
        data.booking_amount,
        data.total_amount,
        data.booking_status
      ], (err, result) => {

        if (err) {
          console.error("Booking insert error:", err);

          if (err.code === "ER_DUP_ENTRY") {
            return res.status(400).json({
              message: "Customer ID already exists. Cannot create duplicate booking."
            });
          }

          return res.status(500).json({
            message: "Booking insert failed"
          });
        }

        const bookingId = result.insertId;

        // ⭐ INSERT DOCUMENTS (SAFE)
        const docSql = `
          INSERT INTO booking_documents 
          (booking_id, aadhaar_file, pan_file, receipt_file)
          VALUES (?,?,?,?)
        `;

        db.query(docSql,
          [bookingId, aadhaarFile, panFile, receiptFile],
          (docErr) => {

            if (docErr) {
              console.error("Document insert error:", docErr);
              // still continue (don’t crash API)
            }

            // ⭐ SEND RESPONSE FIRST (IMPORTANT FOR RAILWAY STABILITY)
            res.json({
              message: "Booking saved successfully ✅",
              bookingId: bookingId
            });

            // ⭐ DEPARTMENT TAT (RUN IN BACKGROUND, SAFE)
            const insertQuery = `
              INSERT INTO department_tat
              (customer_id, booking_id, department, start_time)
              VALUES (?, ?, 'Sales', NOW())
            `;

            db.query(insertQuery,
              [data.customer_id, bookingId],
              (deptErr) => {
                if (deptErr) {
                  console.error("Sales department insert error:", deptErr);
                }
              }
            );

          }
        );
      });

    } catch (error) {
      console.error("Unexpected server error:", error);
      return res.status(500).json({
        message: "Unexpected server error"
      });
    }
  }
);
app.post(
  "/api/upload-documents/:booking_id",
  upload.fields([
    { name: "aadhaar_file", maxCount: 1 },
    { name: "pan_file", maxCount: 1 },
    { name: "receipt_file", maxCount: 1 }   // ⭐ ADD THIS
  ]),

  (req, res) => {

    const bookingId = req.params.booking_id;

    const files = req.files || {};

const aadhaar = files.aadhaar_file
  ? files.aadhaar_file[0].filename
  : null;

const pan = files.pan_file
  ? files.pan_file[0].filename
  : null;

const receipt = files.receipt_file
  ? files.receipt_file[0].filename
  : null;


    if (!aadhaar && !pan && !receipt) {
  return res.status(400).json({ message: "No file selected" });
}


    // 🔎 STEP 1: CHECK IF ROW EXISTS
    db.query(
      "SELECT * FROM booking_documents WHERE booking_id = ?",
      [bookingId],
      (err, rows) => {

        if (err) {
          console.log(err);
          return res.status(500).json({ message: "DB error" });
        }

        // ✅ IF EXISTS → UPDATE
        if (rows.length > 0) {

          let updateFields = [];
          let values = [];

          if (aadhaar) {
  updateFields.push("aadhaar_file = ?");
  values.push(aadhaar);
}

if (pan) {
  updateFields.push("pan_file = ?");
  values.push(pan);
}

if (receipt) {                    // ⭐ ADD THIS
  updateFields.push("receipt_file = ?");
  values.push(receipt);
}


          const updateSql = `
            UPDATE booking_documents
            SET ${updateFields.join(", ")}
            WHERE booking_id = ?
          `;

          values.push(bookingId);

          db.query(updateSql, values, (err2) => {
            if (err2) {
              console.log(err2);
              return res.status(500).json({ message: "Update failed" });
            }

            res.json({ message: "Document updated successfully ✅" });
          });

        }

        // ✅ IF NOT EXISTS → INSERT
        else {

          const insertSql = `
       INSERT INTO booking_documents
     (booking_id, aadhaar_file, pan_file, receipt_file)
      VALUES (?, ?, ?, ?)
`;

        db.query(insertSql, [bookingId, aadhaar, pan, receipt], (err3) => {
            if (err3) {
              console.log(err3);
              return res.status(500).json({ message: "Insert failed" });
            }

            res.json({ message: "Document uploaded successfully ✅" });
          });

        }

      }
    );
  }
);




app.put(
  "/api/update-booking/:id",
  upload.fields([
  { name: "aadhaar_file", maxCount: 1 },
  { name: "pan_file", maxCount: 1 },
  { name: "receipt_file", maxCount: 1 }   // ⭐ NEW FIELD
]),


  (req, res) => {
  const id = req.params.id;

  const {
    customer_id,
    customer_name,
    mobile_number,
    vehicle_model,
    booking_date,
    booking_amount,
    total_amount,
    booking_status
  } = req.body;

  const sql = `
    UPDATE bookings SET
    customer_id=?,
    customer_name=?,
    mobile_number=?,
    vehicle_model=?,
    booking_date=?,
    booking_amount=?,
    total_amount=?,
    booking_status=?
    WHERE booking_id=?
  `;

  db.query(
    sql,
    [
      customer_id,
      customer_name,
      mobile_number,
      vehicle_model,
      booking_date,
      booking_amount,
      total_amount,
      booking_status,
      id
    ],
    err => {
      if (err) return res.json({ error: err });

      /* ⏹ END SALES TAT */
      db.query(
        `UPDATE department_tat
         SET end_time = NOW()
         WHERE booking_id = ?
           AND department = 'Sales'
           AND end_time IS NULL`,
        [id]
      );

     db.query(
  `INSERT INTO department_tat (customer_id, booking_id, department, start_time)
   SELECT customer_id, booking_id, 'Accounts', NOW()
   FROM bookings
   WHERE booking_id = ?
   ON DUPLICATE KEY UPDATE start_time = start_time`,
  [id]
);

      res.json({ success: true });
    }
  );
});


/* ------------ DELETE BOOKING ------------ */
app.delete("/api/delete-booking/:id", (req, res) => {
  db.query(
    "DELETE FROM bookings WHERE booking_id=?",
    [req.params.id],
    err => {
      if (err) return res.json({ error: err });
      res.json({ success: true });
    }
  );
});

app.get("/api/customer-booking/:customer_id", (req, res) => {

const cid = parseInt(req.params.customer_id);

  db.query(
    "SELECT * FROM bookings WHERE customer_id = ?",
    [cid],
    (err, bookingRows) => {

      if (err) return res.status(500).json(err);
      if (bookingRows.length === 0)
        return res.status(404).json({ message: "Customer not found" });

      const booking = bookingRows[0];

      db.query(
        "SELECT IFNULL(SUM(amount_paid),0) AS paid FROM payment_details WHERE booking_id=?",
        [booking.booking_id],
        (err2, payRows) => {

          if (err2) return res.status(500).json(err2);

          // ✅ Correct total payment
          const totalPaid = Number(payRows[0].paid || 0);

          const requiredPayment = Number(booking.total_amount) * 0.5;

          let remaining = requiredPayment - totalPaid;

          if (remaining < 0) remaining = 0;

          res.json({
            ...booking,
            total_paid: totalPaid,
            remaining_amount: remaining,
            payment_status:
              remaining <= 0
                ? "Payment Completed"
                : "Payment Pending"
          });

        }
      );
    }
  );
});

/* =======================================================
   ✅ REQUIRED ADDITION – DO NOT REMOVE
======================================================= */

app.get("/api/completed-bookings", (req, res) => {
  const sql = `
    SELECT 
        b.booking_id,
        b.customer_id,
        b.customer_name,
        b.total_amount,
        b.booking_status,
        COALESCE(SUM(p.amount_paid), 0) AS paid_amount,
        (b.total_amount - COALESCE(SUM(p.amount_paid), 0)) AS remaining_amount
    FROM bookings b
    LEFT JOIN payment_details p 
        ON b.booking_id = p.booking_id   -- FIX 1: join on booking_id not customer_id
    WHERE b.booking_status = 'Completed'
    GROUP BY 
        b.booking_id,
        b.customer_id,
        b.customer_name,
        b.total_amount,
        b.booking_status
    ORDER BY b.booking_id ASC
  `;

  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
});


/* =======================================================
   🔄 SYNC BOOKING → PAYMENT REFER (MISSING STEP)
   Move COMPLETED bookings to payment_refer automatically
======================================================= */
app.post("/api/sync-payment",(req,res)=>{

  console.log("🔄 Sync Booking → Payment started");

  const sql = `
INSERT INTO payment_refer
(
 booking_id,
 customer_name,
 status,
 customer_id,
 booking_amount,
 total_amount,
 total_payment,
 remaining_amount
)
SELECT 
b.booking_id,
b.customer_name,
'Pending',
b.customer_id,
b.booking_amount,
b.total_amount,

-- ⭐ TOTAL PAYMENT (50% - booking)
((b.total_amount * 0.5) - b.booking_amount) AS total_payment,

-- ⭐ REMAINING SAME AS TOTAL PAYMENT
((b.total_amount * 0.5) - b.booking_amount) AS remaining_amount

FROM bookings b
WHERE b.booking_status='Completed'
AND NOT EXISTS (
    SELECT 1 FROM payment_refer p
    WHERE p.booking_id=b.booking_id
);
`;
  db.query(sql,(err,result)=>{
    if(err){
      console.log("❌ Payment Sync Error:",err);
      return res.json({success:false});
    }

    console.log("💰 Customers moved to Payment Department");
    res.json({success:true});
  });

});

app.post("/api/add-payment", (req, res) => {

  console.log("🔥 /api/add-payment API HIT");
  console.log("BODY:", req.body);

  const {
    customer_id,
    booking_id,
    total_amount,
    amount_paid,
    payment_mode,
    payment_date
  } = req.body;


  // ⭐ EXTRA INSERT FOR CANCELLED BOOKING REFUND
db.query(
  `SELECT booking_status FROM bookings WHERE booking_id=?`,
  [booking_id],
  (errStatus, rowsStatus) => {

    if(rowsStatus.length > 0 && rowsStatus[0].booking_status === "Cancelled"){

      db.query(
        `INSERT INTO payment_details
        (customer_id, booking_id, total_amount, amount_paid, payment_mode, payment_date)
        VALUES (?, ?, ?, ?, ?, ?)`,
        [
          customer_id,
          booking_id,
          total_amount,
          amount_paid,
          payment_mode,
          payment_date
        ]
      );

    }

  }
);
  const insertPaymentSQL = `
  INSERT INTO payment_details
  (customer_id, booking_id, total_amount, amount_paid, payment_mode, payment_date)
  VALUES (?, ?, ?, ?, ?, ?)
  `;

  db.query(
    insertPaymentSQL,
    [
      customer_id,
      booking_id,
      total_amount,
      amount_paid,
      payment_mode,
      payment_date
    ],
    (err) => {

      if (err) return res.json({ error: err });

      const checkSQL = `
    SELECT 
  b.booking_id,
  b.customer_id,
  b.customer_name,
  b.total_amount,
  b.booking_amount,
  IFNULL(SUM(p.amount_paid),0) AS total_paid
      FROM bookings b
      LEFT JOIN payment_details p 
        ON b.booking_id = p.booking_id
      WHERE b.booking_id = ?
      GROUP BY b.booking_id
      `;

      db.query(checkSQL, [booking_id], (err2, rows) => {

        if (err2) return res.json({ error: err2 });

        const booking = rows[0];

        const fiftyPercent = booking.total_amount * 0.5;
        const total_payment = fiftyPercent - booking.booking_amount;

        const paid = booking.total_paid;

        let remaining = total_payment - paid;

        if (remaining < 0) remaining = 0;

        console.log("TOTAL:", booking.total_amount);
        console.log("50%:", fiftyPercent);
        console.log("BOOKING:", booking.booking_amount);
        console.log("TOTAL PAYMENT:", total_payment);
        console.log("PAID:", paid);
        console.log("REMAINING:", remaining);

        // // ⭐ CORRECT ACCOUNT STATUS LOGIC
        // db.query(
        //   `SELECT amount FROM account_status WHERE booking_id=?`,
        //   [booking_id],
        //   (errDue, rowsDue)=>{

        //     let previousDue = 0;

        //     if(rowsDue.length > 0){
        //       previousDue = Number(rowsDue[0].amount);
        //     }else{
        //       previousDue = remaining; 
        //     }

        //     let newPayment = Number(amount_paid);

        //     let newDue = previousDue - newPayment;

        //     if(newDue < 0) newDue = 0;

        //     let type = newDue > 0 ? "Due" : "Clear";

        //     db.query(
        //       `DELETE FROM account_status WHERE booking_id=?`,
        //       [booking_id],
        //       ()=>{

        //         db.query(
        //           `INSERT INTO account_status
        //           (customer_id, booking_id, customer_name, type, amount)
        //           VALUES (?,?,?,?,?)`,
        //           [
        //             customer_id,
        //             booking_id,
        //             booking.customer_name,
        //             type,
        //             newDue
        //           ]
        //         );

        //       }
        //     );

        //   }
        // );

        // payment_refer update
        const insertReferSQL = `
        INSERT INTO payment_refer
        (booking_id, customer_name, status, customer_id, booking_amount, total_amount, total_payment, remaining_amount)
        VALUES (?, ?, 'Pending', ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
        total_payment = VALUES(total_payment),
        remaining_amount = VALUES(remaining_amount)
        `;

        db.query(
          insertReferSQL,
          [
            booking_id,
            booking.customer_name,
            customer_id,
            booking.booking_amount,
            booking.total_amount,
            total_payment,
            remaining
          ],
          (err3) => {

            const updateReferSQL = `
            UPDATE payment_refer
            SET 
              remaining_amount = ?,
              status = CASE 
                  WHEN ? <= 0 THEN 'Completed'
                  ELSE 'Pending'
              END
            WHERE booking_id = ?
            `;

          db.query(
  updateReferSQL,
  [remaining, remaining, booking_id],
  (errUpdate) => {

    if(errUpdate){
      console.log(errUpdate);
      return;
    }

   
    if(remaining <= 0){

      db.query(
        `UPDATE department_tat
         SET end_time = NOW()
         WHERE booking_id = ?
         AND department = 'Accounts'
         AND end_time IS NULL`,
        [booking_id]
      );

      db.query(
  `INSERT IGNORE INTO department_tat
   (customer_id, booking_id, department, start_time)
   VALUES (?, ?, ?, NOW())`,
  [customer_id, booking_id, "VehicleAllotment"]
);

      db.query(
        `INSERT INTO vehicleallotment_refer (customer_id, booking_id, status)
         VALUES (?, ?, 'Pending')
         ON DUPLICATE KEY UPDATE status='Pending'`,
        [customer_id, booking_id]
      );

    }

  }
);

          }
        );

  //      if (remaining <= 0) 

  //        db.query(
  //   `UPDATE department_tat
  //    SET end_time = NOW()
  //    WHERE booking_id = ?
  //    AND department = 'Accounts'
  //    AND end_time IS NULL`,
  //   [booking_id]
  // );

  // db.query(
  //   `INSERT IGNORE INTO department_tat
  //    (customer_id, booking_id, department, start_time)
  //    VALUES (?, ?, 'VehicleAllotment', NOW())`,
  //   [customer_id, booking_id]
  // );

  // db.query(
  //   `INSERT INTO vehicleallotment_refer (customer_id, booking_id, status)
  //    VALUES (?, ?, 'Pending')
  //    ON DUPLICATE KEY UPDATE status='Pending'`,
  //   [customer_id, booking_id]
  // );
 db.query(
  `SELECT type, amount FROM account_status WHERE booking_id=?`,
  [booking_id],
  (errStatus, rowsStatus)=>{

      if(rowsStatus.length === 0) return;

      const type = rowsStatus[0].type;
      // ⭐ REFUND PROCESSING


      // ⭐ DUE PROCESSING
if(type === "Due"){

  let dueAmount = Number(rowsStatus[0].amount);
  let newDue = dueAmount - Number(amount_paid);

  if(newDue < 0) newDue = 0;

  let newType = newDue > 0 ? "Due" : "Clear";

  // ✅ UPDATE
  db.query(
    `UPDATE account_status 
     SET amount=?, type=? 
     WHERE booking_id=?`,
    [newDue, newType, booking_id]
  );

  // ✅ IF CLEAR → MOVE TO DELIVERY
  if(newDue === 0){

    db.query(
      `INSERT IGNORE INTO department_tat
       (customer_id, booking_id, department, start_time)
       VALUES (?, ?, 'Delivery', NOW())`,
      [customer_id, booking_id]
    );

    db.query(
      `INSERT INTO delivery_refer (customer_id, booking_id, status)
       VALUES (?, ?, 'Pending')
       ON DUPLICATE KEY UPDATE status='Pending'`,
      [customer_id, booking_id]
    );

  }

}
if(type === "Refund"){

  const refundAmount = Number(rowsStatus[0].amount);
  let newRefund = refundAmount - Number(amount_paid);

  if(newRefund < 0) newRefund = 0;

  let newType = newRefund > 0 ? "Refund" : "Clear";

  // ✅ UPDATE instead of DELETE + INSERT
db.query(
  `UPDATE account_status 
   SET amount=?, type=? 
   WHERE booking_id=?`,
  [
    newRefund,
    newType,
    booking_id
  ]
);

  // move to delivery when refund completed
  if(newRefund === 0){

    db.query(
      `UPDATE department_tat
       SET end_time = NOW()
       WHERE booking_id = ?
       AND department = 'Accounts'
       AND end_time IS NULL`,
      [booking_id]
    );

    db.query(
  `INSERT IGNORE INTO department_tat
   (customer_id, booking_id, department, start_time)
   VALUES (?, ?, 'Delivery', NOW())`,
  [customer_id, booking_id]
);

    // db.query(
    //   `INSERT IGNORE INTO department_tat
    //    (customer_id, booking_id, department, start_time)
    //    VALUES (?, ?, 'Delivery', NOW())`,
    //   [customer_id, booking_id]
    // );

    db.query(
      `INSERT INTO delivery_refer (customer_id, booking_id, status)
       VALUES (?, ?, 'Pending')
       ON DUPLICATE KEY UPDATE status='Pending'`,
      [customer_id, booking_id]
    );

  }

  return; // ⭐ stop normal payment logic
}

      // MOVE ONLY IF PAYMENT CLEAR
      if(type === "Clear"){

  // close Accounts department
  db.query(
    `UPDATE department_tat
     SET end_time = NOW()
     WHERE booking_id = ?
     AND department = 'Accounts'
     AND end_time IS NULL`,
    [booking_id]
  );

  // start Delivery department
  db.query(
    `INSERT IGNORE INTO department_tat
     (customer_id, booking_id, department, start_time)
     VALUES (?, ?, 'Delivery', NOW())`,
    [customer_id, booking_id]
  );

  // insert into delivery dashboard
  db.query(
    `INSERT INTO delivery_refer (customer_id, booking_id, status)
     VALUES (?, ?, 'Pending')
     ON DUPLICATE KEY UPDATE status='Pending'`,
    [customer_id, booking_id]
  );

}

      // IF DUE OR REFUND → STAY IN account_status TABLE

    }
  );


        res.json({ success: true });

      });

    }

  );
});


// GET PAYMENT HISTORY
app.get("/api/payment-history/:bookingId", (req,res)=>{

const bookingId = req.params.bookingId;

const sql = `
SELECT COALESCE(SUM(amount_paid),0) AS total_paid
FROM payment_details
WHERE booking_id = ?
`;

db.query(sql,[bookingId],(err,result)=>{

if(err){
console.log(err);
return res.json({error:err});
}

res.json(result[0]);

});

});

/* ------------ UPDATE PAYMENT ------------ */
app.put("/api/update-payment/:id", (req, res) => {
  const id = req.params.id;

  const {
    customer_id,
    total_amount,
    amount_paid,
    payment_mode,
    payment_date
  } = req.body;

  const sql = `
    UPDATE payment_details SET
    customer_id=?,
    total_amount=?,
    amount_paid=?,
    payment_mode=?,
    payment_date=?
    WHERE payment_id=?
  `;

  db.query(
    sql,
    [customer_id, total_amount, amount_paid, payment_mode, payment_date, id],
    err => {
      if (err) return res.json({ error: err });
      res.json({ success: true });
    }
  );
});

/* ------------ DELETE PAYMENT ------------ */
app.delete("/api/delete-payment/:id", (req, res) => {
  db.query(
    "DELETE FROM payment_details WHERE payment_id=?",
    [req.params.id],
    err => {
      if (err) return res.json({ error: err });
      res.json({ success: true });
    }
  );
});

app.post("/api/cancel-booking", (req, res) => {

  const { customer_id, reason, bank_details } = req.body;

  db.query(
    "SELECT booking_id FROM bookings WHERE customer_id=?",
    [customer_id],
    (err, rows) => {

      if (err) return res.status(500).json(err);
      if (rows.length === 0)
        return res.status(404).json({ message: "Booking not found" });

      const booking_id = rows[0].booking_id;

      db.query(
        "SELECT status FROM invoice_refer WHERE booking_id=?",
        [booking_id],
        (errInv, invRows) => {

          if (errInv) return res.status(500).json(errInv);

          if (invRows.length > 0 && invRows[0].status === "Completed") {
            return res.json({
              success: false,
              message: "❌ Cannot cancel. Invoice already completed."
            });
          }

          db.query(
            "SELECT IFNULL(SUM(amount_paid),0) AS total_paid FROM payment_details WHERE booking_id=?",
            [booking_id],
            (errPay, payRows) => {

              if (errPay) return res.status(500).json(errPay);

              const totalPaid = payRows[0].total_paid;

              console.log("Total Paid:", totalPaid);

              // ⭐ GET BOOKING DETAILS FOR REFUND TABLE
              db.query(
                "SELECT customer_name, total_amount, booking_amount FROM bookings WHERE booking_id=?",
                [booking_id],
                (errB, bookingRows) => {

                  if (errB) return res.status(500).json(errB);

                  const booking = bookingRows[0];

                  const refundAmount =
                    Number(booking.booking_amount) + Number(totalPaid);

                  // ⭐ INSERT INTO cancelled_booking_refunds
                  db.query(
                    `INSERT INTO cancelled_booking_refunds
                    (booking_id, customer_id, customer_name, total_amount,
                     booking_amount, total_paid, refund_amount, status)
                     VALUES (?,?,?,?,?,?,?,?)`,
                    [
                      booking_id,
                      customer_id,
                      booking.customer_name,
                      booking.total_amount,
                      booking.booking_amount,
                      totalPaid,
                      refundAmount,
                      "Pending"
                    ],
                    (errRefund) => {

                      if (errRefund) return res.status(500).json(errRefund);

                      // 1️⃣ UPDATE BOOKINGS TABLE
                      db.query(
                        "UPDATE bookings SET booking_status='Cancelled' WHERE booking_id=?",
                        [booking_id],
                        (errUpdate) => {

                          if (errUpdate) return res.status(500).json(errUpdate);

                          // 🔥 STOP ALL ACTIVE DEPARTMENTS
                          db.query(`
                          UPDATE department_tat
                          SET end_time = NOW()
                          WHERE booking_id=? 
                          AND end_time IS NULL
                          `, [booking_id]);

                          // 🔥 INSERT BOOKING CANCELLED ENTRY
                          db.query(`
                          INSERT INTO department_tat
                          (customer_id, booking_id, department, start_time, end_time)
                          VALUES (?, ?, 'BookingCancelled', NOW(), NOW())
                          `, [customer_id, booking_id]);

                          // 2️⃣ INSERT INTO CANCELLATION TABLE
                          db.query(
                            `INSERT INTO booking_cancellations
                             (customer_id, booking_id, reason, bank_details, cancelled_at)
                             VALUES (?,?,?,?, NOW())`,
                            [customer_id, booking_id, reason, bank_details],
                            (err2) => {

                              if (err2) return res.status(500).json(err2);

                              // 3️⃣ CHECK payment_refer
                              db.query(
                                "SELECT * FROM payment_refer WHERE booking_id=?",
                                [booking_id],
                                (err3, rows2) => {

                                  if (rows2.length === 0) {

                                    db.query(
                                      `INSERT INTO payment_refer
                                       (booking_id, customer_name, status, customer_id, booking_amount, remaining_amount, total_amount)
                                       SELECT
                                         booking_id,
                                         customer_name,
                                         'Pending',
                                         customer_id,
                                         booking_amount,
                                         total_amount - booking_amount,
                                         total_amount
                                       FROM bookings
                                       WHERE booking_id=?`,
                                      [booking_id],
                                      () => {

                                        console.log("Refund Amount:", refundAmount);
                                        res.json({ success: true, refund_amount: refundAmount });

                                      }
                                    );

                                  } else {

                                    db.query(
                                      "UPDATE payment_refer SET status='Pending' WHERE booking_id=?",
                                      [booking_id],
                                      () => {

                                        console.log("Refund Amount:", refundAmount);
                                        res.json({ success: true, refund_amount: refundAmount });

                                      }
                                    );

                                  }

                                }
                              );

                            }
                          );

                        }
                      );

                    }
                  );

                }
              );

            }
          );

        }  
      );

    } 
  );

}); 
app.get("/api/cancelled-booking-refunds",(req,res)=>{

db.query(
`SELECT * FROM cancelled_booking_refunds`,
(err,rows)=>{

if(err) return res.status(500).json(err);

res.json(rows);

});

});
app.post("/api/complete-refund",(req,res)=>{

const {booking_id,customer_id} = req.body;

db.query(
`UPDATE cancelled_booking_refunds
SET status='Completed', updated_at = NOW()
WHERE booking_id = ?;`,
[booking_id],
(err)=>{

if(err) return res.status(500).json(err);

res.json({success:true});

});

});
app.get("/api/cancel-alert", (req, res) => {
  const sql = `
    SELECT 
      c.id,
      c.customer_id,
      b.customer_name,
      c.reason,
      c.bank_details,
      c.cancelled_at
    FROM booking_cancellations c
    JOIN bookings b ON b.customer_id = c.customer_id
    WHERE c.alert_shown = 0
    ORDER BY c.cancelled_at DESC
    LIMIT 1
  `;

  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows.length ? rows[0] : null);
  });
});

/* ---- MARK ALERT AS SHOWN ---- */
app.put("/api/cancel-alert/:id", (req, res) => {
  db.query(
    "UPDATE booking_cancellations SET alert_shown = 1 WHERE id=?",
    [req.params.id],
    err => {
      if (err) return res.status(500).json(err);
      res.json({ success: true });
    }
  );
});


app.get("/api/vehicleallotment-refer", (req, res) =>{
  const sql = "SELECT * FROM vehicleallotment_refer";
  db.query(sql, (err, rows) => {
    if (err) {
      console.log(err);
      return res.status(500).json([]);
    }
    res.json(rows);
  });
});
app.get("/api/invoice-ready", (req, res) => {

  const sql = `
    SELECT 
      i.customer_id,
      b.customer_name,
      i.booking_id,
      i.status
    FROM invoice_refer i
    JOIN bookings b ON b.customer_id = i.customer_id
    ORDER BY i.booking_id ASC
  `;

  db.query(sql, (err, rows) => {
    if (err) return res.status(500).json([]);
    res.json(rows);
  });

});

app.get("/api/invoice/:customer_id", (req, res) => {
  const customer_id = req.params.customer_id;

  const sql = `
    SELECT *
    FROM invoice_details
    WHERE customer_id = ?
    ORDER BY invoice_id DESC
    LIMIT 1
  `;

  db.query(sql, [customer_id], (err, result) => {

    if (err) {
      console.log("DB ERROR:", err);
      return res.status(500).json({ error: "Database error" });
    }

    if (result.length === 0) {
      console.log("❌ No invoice for customer:", customer_id);
      return res.status(404).json({ message: "No invoice found" });
    }

    console.log("✅ Invoice Found:", result[0]);

    res.json(result[0]);
  });
});

app.get("/api/sync-invoice-refer", (req, res) => {

const sql = `
INSERT INTO invoice_refer (customer_id, booking_id, status)
SELECT 
v.customer_id,
v.booking_id,
'Pending'
FROM vehicleallotment_refer v
LEFT JOIN invoice_refer i
ON i.customer_id = v.customer_id
AND i.booking_id = v.booking_id
WHERE v.status = 'Completed'
AND i.customer_id IS NULL
`;

db.query(sql,(err,result)=>{

if(err){
console.log("Invoice sync error:",err);
return res.json({success:false});
}

res.json({
success:true,
inserted: result.affectedRows
});

});

});

app.post("/saveInvoice", (req, res) => {

  const { invoice_number, customer_id, booking_id, invoice_amount, status } = req.body;

  const sql = `
    INSERT INTO invoice_details
    (invoice_number, customer_id, booking_id, invoice_amount, status)
    VALUES (?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
    invoice_number = VALUES(invoice_number),
    booking_id = VALUES(booking_id),
    invoice_amount = VALUES(invoice_amount),
    status = VALUES(status)
  `;

  db.query(sql,
    [invoice_number, customer_id, booking_id, invoice_amount, status],
    (err) => {

      if (err) {
        console.log(err);
        return res.status(500).json(err);
      }

      // Update invoice_refer to Completed
      db.query(
        `UPDATE invoice_refer
         SET status='Completed'
         WHERE customer_id=? AND booking_id=?`,
        [Number(customer_id), Number(booking_id)],
        (err2) => {

          if (err2) {
            console.log("invoice_refer update error:", err2);
          } else {
            console.log("invoice_refer updated");
          }

          // ⭐ NEW: Move to Insurance department after invoice completed

          db.query(
            `UPDATE department_tat
             SET end_time = NOW()
             WHERE booking_id=? AND department='Invoice' AND end_time IS NULL`,
            [booking_id],
            (err3) => {
              if (err3) {
                console.error("department_tat Invoice end_time update error:", err3);
                return res.status(500).json({ error: "Department update failed" });
              }

              // Insert Insurance as next department
              db.query(
                `INSERT INTO department_tat (customer_id, booking_id, department, start_time)
                 VALUES (?, ?, 'Insurance', NOW())`,
                [customer_id, booking_id],
                (err4) => {
                  if (err4) {
                    console.error("department_tat Insurance insert error:", err4);
                    return res.status(500).json({ error: "Department insert failed" });
                  }

                  // Insert or update insurance_refer as Pending
                  db.query(
                    `INSERT INTO insurance_refer (customer_id, booking_id, status)
                     VALUES (?, ?, 'Pending')
                     ON DUPLICATE KEY UPDATE status='Pending'`,
                    [customer_id, booking_id],
                    (err5) => {
                      if (err5) {
                        console.error("insurance_refer update error:", err5);
                        return res.status(500).json({ error: "Insurance refer update failed" });
                      }

                      // ✅ All done, keep existing response
                      res.json({ message: "Invoice Saved Successfully" });
                    }
                  );
                }
              );
            }
          );

        }
      );

    }
  );

});
app.get("/api/payment-reference", (req, res) => {
  db.query("SELECT * FROM payment_refer", (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
});
app.get("/api/invoice-refer", (req, res) => {

  const sql = "SELECT * FROM invoice_refer";

  db.query(sql, (err, rows) => {

    if (err) {
      console.error("Error loading invoice_refer:", err);
      return res.status(500).json({ error: "DB error" });
    }

    res.json(rows);

  });

});


app.post("/api/save-insurance", (req, res) => {

  const {
    customer_id,
    customer_name,
    insurance_company,
    policy_number,
    policy_type,
    policy_amount
  } = req.body;

  // 1️⃣ INSERT INTO insurance_details table
  const insertSQL = `
    INSERT INTO insurance_details
    (customer_id, insurance_company, policy_number, policy_type, policy_amount)
    VALUES (?, ?, ?, ?, ?)
  `;

  db.query(
    insertSQL,
    [customer_id, insurance_company, policy_number, policy_type, policy_amount],
    (err) => {

      if (err) {
        console.log("❌ insurance_details insert error:", err);
        return res.json({ success:false });
      }

      // 2️⃣ UPDATE insurance_refer status → Completed
      const updateSQL = `
        UPDATE insurance_refer
        SET status='Completed'
        WHERE customer_id=?
      `;
      // ⏹ END INSURANCE TAT
db.query(
  `UPDATE department_tat
   SET end_time = NOW()
   WHERE customer_id=? AND department='Insurance' AND end_time IS NULL`,
  [customer_id]
);

// ▶ START RTO TAT
db.query(
  `INSERT INTO department_tat
   (customer_id, booking_id, department, start_time)
   SELECT customer_id, booking_id, 'RTO', NOW()
   FROM insurance_refer
   WHERE customer_id=?
   ON DUPLICATE KEY UPDATE start_time = start_time`,
  [customer_id]
);

      

      db.query(updateSQL,[customer_id],(err2)=>{
        if(err2){
          console.log("❌ insurance_refer update error:", err2);
          return res.json({ success:false });
        }

        console.log("✅ Insurance saved & completed");
        res.json({ success:true });
      });

    }
  );

});
app.post("/api/update-insurance", (req, res) => {

  const {
    customer_id,
    insurance_company,
    policy_number,
    policy_type,
    policy_amount
  } = req.body;

  const sql = `
    UPDATE insurance_details SET
      insurance_company = ?,
      policy_number = ?,
      policy_type = ?,
      policy_amount = ?
    WHERE customer_id = ?
  `;

  db.query(
    sql,
    [
      insurance_company,
      policy_number,
      policy_type,
      policy_amount,
      customer_id
    ],
    (err) => {
      if (err) {
        console.log("❌ insurance update error:", err);
        return res.json({ success:false });
      }
      res.json({ success:true });
    }
  );
});



/* 3️⃣ LOAD INSURANCE RECORDS TABLE */
app.get("/api/insurance",(req,res)=>{

  db.query("SELECT * FROM insurance_refer",(err,result)=>{
    if(err){
      console.log("❌ insurance load error:", err);
      return res.status(500).json([]);
    }
    res.json(result);
  });

});
app.post("/api/sync-insurance", (req, res) => {

  const sql = `
  INSERT INTO insurance_refer (customer_id, booking_id, status)
  SELECT 
    i.customer_id,
    i.booking_id,
    'Pending'
  FROM invoice_refer i
  LEFT JOIN insurance_refer ir 
    ON ir.customer_id = i.customer_id
  WHERE i.status = 'Completed'
    AND ir.customer_id IS NULL
`;


  db.query(sql, (err, result) => {
    if (err) {
      console.log("❌ insurance sync error:", err);
      return res.json({ success: false });
    }

    res.json({ success: true, inserted: result.affectedRows });
  });

});

app.get("/api/insurance-details/:customer_id", (req, res) => {

  const sql = `
    SELECT 
      customer_id,
      insurance_company,
      policy_number,
      policy_type,
      policy_amount
    FROM insurance_details
    WHERE customer_id = ?
  `;

  db.query(sql, [req.params.customer_id], (err, rows) => {

    if (err) {
      console.log(err);
      return res.status(500).json({ error: "Database error" });
    }

    if (rows.length === 0) {
      return res.json([]);
    }

    res.json(rows);   // ✅ RETURN FULL ARRAY
  });
});


app.post("/api/sync-rto", (req,res)=>{

  const sql = `
INSERT IGNORE INTO rto_refer (customer_id, booking_id, status)
SELECT 
  customer_id,
  booking_id,
  'Pending'
FROM insurance_refer
WHERE status='Completed'
`;

  db.query(sql,(err,result)=>{
     if(err){
       console.log("❌ RTO sync error:", err);
       return res.json({success:false});
     }
     console.log("✅ RTO Sync Done");
     res.json({success:true});
  });

});

/* 2️⃣ GET RTO PENDING CUSTOMERS (show in dashboard) */
app.get("/api/rto-customers", (req,res)=>{
  const sql = `
    SELECT 
      rr.customer_id,
      rr.booking_id,
      b.customer_name,
      rr.status
    FROM rto_refer rr
    JOIN bookings b ON b.booking_id = rr.booking_id
    ORDER BY rr.customer_id ASC
  `;
  db.query(sql,(err,result)=>{
    if(err) return res.json([]);
    res.json(result);
  });
});
/* -------------------------------------------------------
   CHECK RTO CUSTOMER STATUS (REQUIRED)
------------------------------------------------------- */
app.get("/api/check-rto/:customer_id", (req, res) => {

  const customer_id = req.params.customer_id.trim();

  const sql = `
    SELECT status
    FROM rto_refer
    WHERE TRIM(customer_id) = ?
  `;

  db.query(sql, [customer_id], (err, rows) => {

    if (err) {
      console.log(err);
      return res.json({ exists: false });
    }

    if (rows.length === 0) {
      return res.json({ exists: false });
    }

    res.json({
      exists: true,
      status: rows[0].status
    });

  });

});
/* =======================================================
   ✅ CHECK RTO CUSTOMER STATUS
======================================================= */
app.get("/api/check-rto/:customer_id", (req, res) => {

  const customer_id = req.params.customer_id;

  const sql = `
    SELECT status
    FROM rto_refer
    WHERE customer_id = ?
  `;

  db.query(sql, [customer_id], (err, rows) => {

    if (err) {
      console.log("❌ RTO check error:", err);
      return res.status(500).json({ exists: false });
    }

    if (rows.length === 0) {
      return res.json({ exists: false });
    }

    res.json({
      exists: true,
      status: rows[0].status
    });
  });
});



/* 3️⃣ SAVE RTO DETAILS + MARK COMPLETED + MOVE TO ACCESSORIES */
app.post("/api/save-rto",(req,res)=>{

 const customer_id = req.body.customer_id.trim();
const receipt_no = req.body.receipt_no;
const registration_no = req.body.registration_no;
const registration_date = req.body.registration_date;
const registration_amount = req.body.registration_amount;

  // 1️⃣ Insert into rto_details
  const insertSQL = `
  INSERT INTO rto_details
  (customer_id, receipt_no, registration_no, registration_date, registration_amount)
  VALUES (?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    receipt_no = VALUES(receipt_no),
    registration_no = VALUES(registration_no),
    registration_date = VALUES(registration_date),
    registration_amount = VALUES(registration_amount)
  `;

  db.query(insertSQL,
  [customer_id, receipt_no, registration_no, registration_date, registration_amount],
  (err)=>{
    if(err){
      console.log("❌ rto_details insert error:", err);
      return res.json({success:false});
    }

    // 2️⃣ Update rto_refer status → Completed
  const updateRTO = `
UPDATE rto_refer
SET status='Completed'
WHERE TRIM(customer_id)=?
`;
db.query(updateRTO,[customer_id],(err2,result)=>{

  if(err2){
    console.log("❌ rto_refer update error:", err2);
    return res.json({success:false});
  }

  console.log("Rows Updated:", result.affectedRows);

  console.log("✅ RTO Completed");

      // ⏹ END RTO TAT
      db.query(
        `UPDATE department_tat
         SET end_time = NOW()
         WHERE customer_id=? AND department='RTO' AND end_time IS NULL`,
        [customer_id]
      );

      // ▶ START FASTAG TAT
db.query(
  `INSERT INTO department_tat
  (customer_id, booking_id, department, start_time)
  SELECT customer_id, booking_id, 'FASTag', NOW()
  FROM rto_refer
  WHERE customer_id = ?
  ON DUPLICATE KEY UPDATE start_time=start_time`,
  [customer_id]
);

     const moveToFastagSQL = `
  INSERT INTO fastag_refer (customer_id, booking_id, status)
  SELECT customer_id, booking_id, 'Pending'
  FROM rto_refer
  WHERE customer_id = ?
  AND status='Completed'
 AND NOT EXISTS (
  SELECT 1 FROM fastag_refer 
  WHERE customer_id = rto_refer.customer_id
  AND booking_id = rto_refer.booking_id
)
`;

db.query(moveToFastagSQL,[customer_id],(err3)=>{
  if(err3){
    console.log("❌ FASTag insert error:", err3);
    return res.json({success:false});
  }

  console.log("✅ Customer moved to FASTag Department");

  res.json({success:true});
});

    });

  });

});
// =============================================
// LOAD INSURANCE COMPLETED CUSTOMERS INTO RTO
// =============================================
app.post("/api/load-rto-customers", (req,res)=>{

  const query = `
    SELECT customer_id, booking_id, 'Pending'
    FROM insurance_refer
    WHERE status='Completed'

  `;

  db.query(query,(err,result)=>{
    if(err){
      console.log(err);
      return res.json({success:false});
    }
    res.json({success:true});
  });

});
// =============================================
// GET RTO CUSTOMERS
// =============================================
app.get("/api/get-rto-customers",(req,res)=>{

  const query = "SELECT * FROM rto_refer";

  db.query(query,(err,result)=>{
    if(err){
      console.log(err);
      return res.json([]);
    }
    res.json(result);
  });

});

app.get("/api/rto-ready", (req,res)=>{

  const sql = `
    SELECT 
      ir.customer_id,
      ir.customer_name,
      rr.status
    FROM insurance_refer ir
    JOIN rto_refer rr 
        ON ir.customer_id = rr.customer_id
    WHERE ir.status = 'Completed'
      AND rr.status = 'Pending'
    ORDER BY ir.customer_id ASC
  `;

  db.query(sql,(err,result)=>{
    if(err){
      console.log("❌ RTO ready error:", err);
      return res.json([]);
    }
    res.json(result);
  });

});

  
// app.post("/api/sync-delivery", (req, res) => {

// const sql = `
// INSERT INTO delivery_refer (customer_id, booking_id, status)
// SELECT 
//   ar.customer_id,
//   ar.booking_id,
//   'Pending'
// FROM accessories_refer ar
// WHERE ar.status = 'Completed'

// AND (
//   SELECT IFNULL(SUM(ac.amount),0)
//   FROM account_status ac
//   WHERE ac.customer_id = ar.customer_id
//   AND ac.booking_id = ar.booking_id
// ) <= 0

// AND NOT EXISTS (
//   SELECT 1
//   FROM delivery_refer dr
//   WHERE dr.customer_id = ar.customer_id
//   AND dr.booking_id = ar.booking_id
// )
// `;

// db.query(sql, (err, result) => {

// if (err) {
//   console.log("❌ Delivery sync error:", err);
//   return res.status(500).json({ message: "Delivery sync failed" });
// }

// console.log("✅ Delivery synced:", result.affectedRows);

// res.json({ message: "Delivery sync done" });

// });

// });

/* 1️⃣ GET DELIVERY CUSTOMERS (show in dashboard) */
app.get("/api/delivery", (req,res)=>{
  /* =======================================================
   🚚 DELIVERY DASHBOARD WITH TAT
======================================================= */



  const sql = `
    SELECT * FROM delivery_refer
    ORDER BY customer_id ASC
  `;

  db.query(sql,(err,result)=>{
    if(err){
      console.log("❌ delivery load error:", err);
      return res.json([]);
    }

    res.json(result);
  });

});


/* 2️⃣ MARK VEHICLE AS DELIVERED */
app.put("/api/delivery-complete/:customer_id",(req,res)=>{

  const customer_id = req.params.customer_id;

  const sql = `
    UPDATE delivery_refer
    SET status='Completed'
    WHERE customer_id=?
  `;
  // ⏹ END DELIVERY TAT
db.query(
  `UPDATE department_tat
   SET end_time = NOW()
   WHERE customer_id=? AND department='Delivery' AND end_time IS NULL`,
  [customer_id]
);


  db.query(sql,[customer_id],(err)=>{
    if(err){
      console.log("❌ delivery update error:", err);
      return res.json({success:false});
    }

    console.log("🚚 Vehicle Delivered:", customer_id);
    res.json({success:true});
  });

});


app.get("/api/customer-full-details/:id", (req, res) => {
  const customerId = req.params.id;

  const sql = `
    SELECT 
      ir.customer_id,
      ir.booking_id,
      ir.status AS invoice_status,

      idt.insurance_company,
      idt.policy_number,
      idt.policy_type,
      idt.policy_amount,

      rd.receipt_no,
      rd.registration_no,
      rd.registration_date,
      rd.registration_amount,

      dr.status AS status   -- ⭐ ADD THIS

    FROM invoice_refer ir

    LEFT JOIN insurance_details idt 
      ON idt.customer_id = ir.customer_id

    LEFT JOIN rto_details rd 
      ON rd.customer_id = ir.customer_id

    LEFT JOIN delivery_refer dr       -- ⭐ ADD THIS
      ON dr.customer_id = ir.customer_id

    WHERE ir.customer_id = ?
  `;

  db.query(sql, [customerId], (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "DB Error" });
    }

    if (result.length === 0) {
      return res.json({});
    }

    res.json(result[0]);
  });
});


app.get("/getInvoices", (req, res) => {

  const sql = "SELECT * FROM invoice_details ORDER BY invoice_id DESC";

  db.query(sql, (err, result) => {
    if (err) {
      console.log("❌ Invoice Fetch Error:", err);
      return res.status(500).json([]);
    }

    console.log("📄 Sending invoices:", result);
    res.json(result);   // IMPORTANT → send array directly
  });

});
/* =======================================================
   🔁 GET RTO DETAILS FOR EDIT
======================================================= */
app.get("/api/rto-details/:customer_id", (req, res) => {

  const customer_id = req.params.customer_id;

  const sql = `
    SELECT *
    FROM rto_details
    WHERE customer_id = ?
    LIMIT 1
  `;

  db.query(sql, [customer_id], (err, rows) => {
    if (err) {
      console.log("❌ rto-details fetch error:", err);
      return res.status(500).json(null);
    }

    if (rows.length === 0) {
      return res.json(null);
    }

    res.json(rows[0]);
  });
});
app.get("/api/admin-tat", (req, res) => {

  const department = req.query.department;
  const statusFilter = req.query.status;   // existing filter
  const SLA_HOURS = 24; 

  let sql = `
    SELECT *
    FROM (
      SELECT
        id,
        customer_id,
        booking_id,
        department,
        start_time,
        end_time,
        

        ROUND(
          TIMESTAMPDIFF(HOUR, start_time, IFNULL(end_time, NOW())) / 24,
          2
        ) AS tat_days,

        CASE
          WHEN end_time IS NULL 
               AND TIMESTAMPDIFF(HOUR, start_time, NOW())/24 <= ${SLA}
          THEN 'In Progress'

          WHEN end_time IS NULL 
               AND TIMESTAMPDIFF(HOUR, start_time, NOW())/24 > ${SLA}
          THEN 'Delayed'

          WHEN end_time IS NOT NULL 
               AND TIMESTAMPDIFF(HOUR, start_time, end_time)/24 <= ${SLA}
          THEN 'Completed'

          WHEN end_time IS NOT NULL 
               AND TIMESTAMPDIFF(HOUR, start_time, end_time)/24 > ${SLA}
          THEN 'Delayed'
        END AS status

      FROM department_tat
    ) AS subquery
    WHERE 1=1
  `;

  let params = [];

  /* Department filter (existing) */
  if (department) {
    sql += ` AND department = ? `;
    params.push(department);
  }

  /* Status filter (existing) */
  if (statusFilter) {
    sql += ` AND status = ? `;
    params.push(statusFilter);
  }

  /* ORDERING (existing) */
  sql += ` ORDER BY booking_id, id`;

  db.query(sql, params, (err, rows) => {

    if (err) {
      console.log("Error in /api/admin-tat:", err);
      return res.json([]);
    }

    res.json(rows);

  });

});

app.get("/api/download-receipt/:id", (req, res) => {

  const id = req.params.id;

  const sql = "SELECT * FROM bookings WHERE booking_id = ?";

  db.query(sql, [id], (err, rows) => {

    if (err) {
      console.log(err);
      return res.status(500).send("Database Error");
    }

    if (rows.length === 0) {
      return res.status(404).send("Booking not found");
    }

    const b = rows[0];

    const fileName = `booking_receipt_${b.booking_id}.pdf`;
 res.setHeader(
  "Content-Disposition",
  `attachment; filename=Sales_${b. booking_id}.pdf`
);

    const doc = new PDFDocument({ margin: 50 });

    doc.pipe(res);

    const formattedDate = new Date(b.booking_date).toLocaleDateString("en-IN");

    doc.fontSize(22).text("Vehicle Booking Receipt", { align: "center" });

    doc.moveDown();

    doc.fontSize(14);
    doc.text(`Booking ID: ${b.booking_id}`);
    doc.text(`Customer ID: ${b.customer_id}`);
    doc.text(`Customer Name: ${b.customer_name}`);
    doc.text(`Mobile Number: ${b.mobile_number}`);
    doc.text(`Vehicle Model: ${b.vehicle_model}`);
    doc.text(`Booking Date: ${formattedDate}`);
    doc.text(`Booking Amount: ₹${b.booking_amount}`);
    doc.text(`Total Amount: ₹${b.total_amount}`);
    doc.text(`Status: ${b.booking_status}`);

    doc.moveDown();

    doc.text("Thank you for booking with us!", { align: "center" });

    doc.end();

  });

});


app.get("/api/download-payment/:paymentId", (req, res) => {

  const paymentId = req.params.paymentId;

  const sql = `
    SELECT p.*, b.customer_name
    FROM payment_details p
    JOIN bookings b ON p.booking_id = b.booking_id
    WHERE p.payment_id = ?
  `;

  db.query(sql, [paymentId], (err, result) => {

    if (err) return res.status(500).send("DB error");
    if (result.length === 0) return res.status(404).send("Payment not found");

    const p = result[0];

    // ✅ CREATE PDF DOCUMENT
    const doc = new PDFDocument();

    res.setHeader(
  "Content-Disposition",
  `attachment; filename=Payment_${p.payment_id}.pdf`
);

    // ✅ PIPE PDF TO RESPONSE
    doc.pipe(res);

    /* ===== RECEIPT DESIGN ===== */
    doc.fontSize(22).text("Payment Receipt", { align: "center" });
    doc.moveDown();

    doc.fontSize(14);
    doc.text(`Payment ID: ${p.payment_id}`);
    doc.text(`Customer Name: ${p.customer_name}`);
    doc.text(`Customer ID: ${p.customer_id}`);
    doc.text(`Booking ID: ${p.booking_id}`);
    doc.text(`Total Amount: ₹ ${p.total_amount}`);
    doc.text(`Amount Paid: ₹ ${p.amount_paid}`);
    doc.text(`Payment Mode: ${p.payment_mode}`);
    doc.text(`Payment Date: ${p.payment_date}`);

    doc.moveDown();
    doc.text("Thank you for your payment 🙏", { align: "center" });

    doc.end();
  });
});

app.get("/api/download-transaction-receipt/:customerId", (req, res) => {

  const customerId = req.params.customerId;

  const sql = `
    SELECT payment_id, customer_id, booking_id, 
           total_amount, amount_paid, payment_mode,
           DATE_FORMAT(payment_date, '%Y-%m-%d') AS payment_date
    FROM payment_details
    WHERE customer_id = ?
    ORDER BY payment_date ASC
  `;

  db.query(sql, [customerId], (err, results) => {

    if (err) return res.status(500).send("DB error");
    if (results.length === 0) return res.status(404).send("No payments found");

    const doc = new PDFDocument({ margin: 40 });

    const mode = req.query.mode;

    if (mode === "view") {
      res.setHeader(
        "Content-Disposition",
        `inline; filename=Transaction_${customerId}.pdf`
      );
    } else {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=Transaction_${customerId}.pdf`
      );
    }

    res.setHeader("Content-Type", "application/pdf");

    doc.pipe(res);

    /* ===== TITLE ===== */
    doc.fontSize(20).text("Transaction Receipt", { align: "center" });
    doc.moveDown(2);

    /* ===== TABLE HEADER ===== */
    doc.fontSize(12);
    doc.font("Courier");

    doc.text("PID   CID   BID   TOTAL        PAID         MODE      DATE");
    doc.text("--------------------------------------------------------------------------");

    /* ===== TABLE ROWS ===== */
    results.forEach((p) => {

      const formattedDate = p.payment_date; // Already formatted in SQL

      doc.text(
        `${p.payment_id.toString().padEnd(5)} ` +
        `${p.customer_id.toString().padEnd(5)} ` +
        `${p.booking_id.toString().padEnd(5)} ` +
        `${p.total_amount.toString().padEnd(12)} ` +
        `${p.amount_paid.toString().padEnd(12)} ` +
        `${p.payment_mode.padEnd(9)} ` +
        `${formattedDate}`
      );
    });

    doc.moveDown(2);
    doc.font("Helvetica");
    doc.text("Thank You", { align: "center" });

    doc.end();
  });
});
/* ================= GET ALL RECEIPTS BY BOOKING ================= */
app.get("/api/booking-receipts/:bookingId", (req,res)=>{
  const bookingId = req.params.bookingId;

  const sql = "SELECT * FROM booking_documents WHERE booking_id = ?";
  db.query(sql,[bookingId],(err,result)=>{
    if(err) return res.status(500).send(err);
    res.json(result);
  });
});
// upload receipt after payment  ✅ NEW FINAL VERSION
app.post(
  "/api/upload-payment-receipt/:paymentId",
  upload.single("receipt_file"),
  (req, res) => {

    const paymentId = req.params.paymentId;   // ⭐ correct param

    if (!req.file) {
      return res.status(400).send("No file uploaded");
    }

    const fileName = req.file.filename;

    // 🔎 STEP 1: find booking_id using payment_id
    const findSql = `
      SELECT booking_id
      FROM payment_details
      WHERE payment_id = ?
    `;

    db.query(findSql, [paymentId], (err, rows) => {

      if (err || rows.length === 0) {
        console.log("Payment not found");
        return res.status(500).send("Payment not found");
      }

      const bookingId = rows[0].booking_id;

      // 💾 STEP 2: INSERT into payment_receipts table
      const insertSql = `
        INSERT INTO payment_receipts (payment_id, booking_id, receipt_file)
        VALUES (?, ?, ?)
      `;

      db.query(insertSql, [paymentId, bookingId, fileName], (err2) => {

        if (err2) {
          console.log("Receipt insert error:", err2);
          return res.status(500).send("DB error");
        }

        console.log("✅ Receipt saved in payment_receipts table");
        res.send("Receipt uploaded successfully");
      });

    });

  }
);
/* 🔎 GET LATEST PAYMENT ID */
app.get("/api/latest-payment/:bookingId",(req,res)=>{

  const sql = `
    SELECT payment_id 
    FROM payment_details
    WHERE booking_id=?
    ORDER BY payment_id DESC LIMIT 1
  `;

  db.query(sql,[req.params.bookingId],(err,rows)=>{
    if(err || rows.length===0) return res.json({});
    res.json(rows[0]);
  });

});
/* =======================================================
   📤 UPLOAD PAYMENT RECEIPT (FINAL API)
======================================================= */
app.post("/api/upload-payment-receipt/:booking_id",
  upload.single("receipt"),
  (req,res)=>{

  const bookingId = req.params.booking_id;
  const fileName = req.file?.filename;

  if(!fileName){
    return res.status(400).json({message:"No file uploaded"});
  }

  // 👉 attach receipt to LAST payment of this booking
  const sql = `
    UPDATE payment_details
    SET receipt_file = ?
    WHERE booking_id = ?
    ORDER BY payment_id DESC
    LIMIT 1
  `;

  db.query(sql,[fileName, bookingId],(err)=>{
    if(err){
      console.log(err);
      return res.status(500).json({message:"DB error"});
    }

    res.json({message:"Receipt uploaded successfully"});
  });

});
app.get("/api/payment-receipts/:booking_id", (req,res)=>{

  const bookingId = req.params.booking_id;

  const sql = `
    SELECT payment_id,  booking_id, receipt_file
    FROM payment_receipts
    WHERE booking_id = ?
    ORDER BY id ASC
  `;

  db.query(sql,[bookingId],(err,rows)=>{
    if(err){
      console.log(err);
      return res.json([]);
    }

    res.json(rows);   // 🔥 now returns ONLY uploaded receipts
  });

});
app.post("/api/upload-invoice-receipt", upload.single("receipt"), (req, res) => {

  try {

    const bookingId = req.body.booking_id;   // ✅ FIX HERE
    const fileName = req.file.filename;

    console.log("Booking ID:", bookingId);
    console.log("File:", fileName);

    if (!bookingId) {
      return res.status(400).json({ error: "Booking ID missing" });
    }

    const sql = `
      INSERT INTO invoice_receipts (booking_id, receipt_file)
      VALUES (?,?)
    `;

    db.query(sql, [bookingId, fileName], (err, result) => {

      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Database insert failed" });
      }

      res.json({
        success: true,
        message: "Receipt uploaded successfully"
      });

    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload error" });
  }

});
// /* =======================================================
//    📥 DOWNLOAD INVOICE RECEIPT
// ======================================================= */
// app.get("/api/download-invoice/:invoiceId", (req, res) => {

//   const invoiceId = req.params.invoiceId;

//   const sql = `
//     SELECT receipt_file
//     FROM invoice_receipts
//     WHERE invoice_id = ?
//     ORDER BY id DESC
//     LIMIT 1
//   `;

//   db.query(sql, [invoiceId], (err, rows) => {

//     if (err) {
//       console.log("❌ DB error:", err);
//       return res.status(500).send("Database error");
//     }

//     if (rows.length === 0) {
//       return res.status(404).send("No receipt found");
//     }

//     const fileName = rows[0].receipt_file;
//     const filePath = path.join(__dirname, "uploads", fileName);

//     res.download(filePath);

//   });

// });

/* =======================================================
   🔎 GET LATEST INVOICE OF BOOKING
======================================================= */
app.get("/api/latest-invoice/:booking_id",(req,res)=>{

  const bookingId = req.params.booking_id;

  const sql = `
    SELECT invoice_id FROM invoice_details
    WHERE booking_id = ?
    ORDER BY invoice_id DESC
    LIMIT 1
  `;

  db.query(sql,[bookingId],(err,rows)=>{
    if(err || rows.length === 0){
      return res.json({});
    }
    res.json(rows[0]);
  });

});
/* =======================================================
   📤 UPLOAD PAYMENT RECEIPT (PER BOOKING PAYMENT)
======================================================= */
app.post(
  "/api/upload-payment-receipt/:bookingId",
  upload.single("receipt_file"),
  (req, res) => {

    const bookingId = req.params.bookingId;
    const fileName = req.file.filename;

    const sql = `
      UPDATE payment_details 
      SET receipt_file = ?
      WHERE booking_id = ?
      ORDER BY payment_id DESC
      LIMIT 1
    `;

    db.query(sql, [fileName, bookingId], (err) => {
      if (err) {
        console.log(err);
        return res.status(500).send("Upload failed");
      }

      console.log("✅ Receipt attached to latest payment");
      res.send("Receipt uploaded successfully");
    });
  }
);/* =======================================================
   💰 PAYMENT RECEIPT UPLOAD API (FINAL FIX)
======================================================= */

app.post("/api/upload-payment-receipt/:paymentId", upload.single("receipt_file"), (req, res) => {

  const bookingId = req.params.bookingId;

  if (!req.file) {
    return res.status(400).send("No file uploaded");
  }

  const fileName = req.file.filename;

  // attach receipt to LAST payment of this booking
  const sql = `
    UPDATE payment_details
    SET receipt_file = ?
    WHERE booking_id = ?
    ORDER BY payment_id DESC
    LIMIT 1
  `;

  db.query(sql, [fileName, bookingId], (err) => {
    if (err) {
      console.log("Receipt Upload Error:", err);
      return res.status(500).send("DB error");
    }

    console.log("✅ Payment receipt saved:", fileName);
    res.send("Receipt uploaded successfully");
  });

});
/* =======================================================
   📥 GET PAYMENT RECEIPTS (FIXED)
======================================================= */

app.get("/api/payment-receipts/:bookingId", (req, res) => {

  const bookingId = req.params.bookingId;

  const sql = `
    SELECT 
      pd.payment_id,
      pd.amount_paid,
      pr.receipt_file
    FROM payment_details pd
    JOIN payment_receipts pr 
      ON pd.payment_id = pr.payment_id
    WHERE pd.booking_id = ?
    ORDER BY pd.payment_id DESC
  `;

  db.query(sql, [bookingId], (err, rows) => {
    if (err) {
      console.log(err);
      return res.json([]);
    }

    res.json(rows);
  });

});

app.use("/uploads", express.static("uploads"));

/* =======================================================
   📄 UPLOAD PAYMENT RECEIPT (NEW TABLE)
======================================================= */

app.post("/api/upload-payment-receipt/:paymentId",
upload.single("receipt_file"),
(req,res)=>{

  const paymentId = req.params.paymentId;

  if(!req.file)
    return res.status(400).send("No file uploaded");

  const fileName = req.file.filename;

  const sql = `
    INSERT INTO payment_receipts (payment_id, booking_id, receipt_file)
    SELECT payment_id, booking_id, ?
    FROM payment_details
    WHERE payment_id = ?
  `;

  db.query(sql,[fileName,paymentId],(err)=>{
    if(err){
      console.log("Receipt upload error:",err);
      return res.status(500).send("DB error");
    }

    console.log("✅ Receipt saved in payment_receipts");
    res.send("Receipt uploaded successfully");
  });

});

/* =======================================================
   📄 GET ALL RECEIPTS FOR VIEW BUTTON
======================================================= */

app.get("/api/payment-receipts/:bookingId",(req,res)=>{

  const bookingId = req.params.bookingId;

  const sql = `
    SELECT 
      pd.payment_id,
      pd.amount_paid,
      pr.receipt_file
    FROM payment_receipts pr
    JOIN payment_details pd
      ON pr.payment_id = pd.payment_id
    WHERE pr.booking_id = ?
    ORDER BY pr.id DESC
  `;

  db.query(sql,[bookingId],(err,rows)=>{
    if(err){
      console.log("Receipt fetch error:",err);
      return res.json([]);
    }

    res.json(rows);
  });

});
// 🔹 Get Single Invoice Details
app.get("/api/invoice/:invoiceId", (req, res) => {

  const invoiceId = req.params.invoiceId;

  const sql = `
    SELECT * FROM invoice_details
    WHERE invoice_id = ?
  `;

  db.query(sql, [invoiceId], (err, result) => {

    if (err) {
      console.error(err);
      return res.status(500).json({ error: "Database error" });
    }

    if (result.length === 0) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    res.json(result[0]);
  });
});
// 🔹 Get Invoice By Customer ID (FOR EDIT)
app.get("/api/invoice-by-customer/:customerId", (req, res) => {

  const customerId = req.params.customerId;

  const sql = `
    SELECT * FROM invoice_details
    WHERE customer_id = ?
  `;

  db.query(sql, [customerId], (err, result) => {

    if (err) {
      console.error(err);
      return res.status(500).json({ error: "Database error" });
    }

    if (result.length === 0) {
      return res.status(404).json({ error: "No invoice for this customer" });
    }

    res.json(result[0]);
  });

});

app.get("/api/download-invoice-pdf/:customerId", (req, res) => {

  const customerId = req.params.customerId;

  const sql = `
    SELECT *
    FROM invoice_details
    WHERE customer_id = ?
    LIMIT 1
  `;

  db.query(sql, [customerId], (err, rows) => {

    if (err) {
      console.log("❌ Invoice PDF DB error:", err);
      return res.status(500).send("Database error");
    }

    if (rows.length === 0) {
      return res.status(404).send("Invoice not found");
    }

    const data = rows[0];

    // ✅ IMPORT PDFKIT
    const PDFDocument = require("pdfkit");
    const doc = new PDFDocument({ margin: 50 });
const type = req.query.type;   
res.setHeader("Content-Type", "application/pdf");

if (type === "download") {
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=Invoice_${data.customer_id}.pdf`
  );
} else {
  res.setHeader(
    "Content-Disposition",
    `inline; filename=Invoice_${data.customer_id}.pdf`
  );
}
    doc.pipe(res);

    doc.fontSize(22).text("INVOICE", { align: "center" });
    doc.moveDown(2);

    doc.fontSize(14);

    doc.text(`Invoice ID: ${data.invoice_id}`);
    doc.text(`Invoice Number: ${data.invoice_number}`);
    doc.text(`Customer ID: ${data.customer_id}`);
    doc.text(`Booking ID: ${data.booking_id}`);
    doc.text(`Invoice Amount: ₹ ${data.invoice_amount}`);
    doc.text(`Status: ${data.status}`);

    doc.moveDown(2);
    doc.text("Thank you for your business 🙏", { align: "center" });
    doc.end();

  });

});


app.get("/api/download-insurance-pdf/:customerId", (req, res) => {

  const customerId = req.params.customerId;

  const sql = `
    SELECT *
    FROM insurance_details
    WHERE customer_id = ?
    ORDER BY insurance_id DESC
    LIMIT 1
  `;

  db.query(sql, [customerId], (err, rows) => {

    if (err) {
      console.log("❌ Insurance PDF DB error:", err);
      return res.status(500).send("Database error");
    }

    if (rows.length === 0) {
      return res.status(404).send("Insurance details not found");
    }

    const data = rows[0];

    const doc = new PDFDocument({ margin: 50 });

    // ✅ Check mode
const type = req.query.type;   // view OR download

res.setHeader("Content-Type", "application/pdf");

if (type === "download") {
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=Insurance_${data.customer_id}.pdf`
  );
} else {
  res.setHeader(
    "Content-Disposition",
    `inline; filename=Insurance_${data.customer_id}.pdf`
  );
}

    doc.pipe(res);
    doc.fontSize(22).text("INSURANCE RECEIPT", { align: "center" });
    doc.moveDown(2);

    doc.fontSize(14);

    doc.text(`Insurance ID: ${data.insurance_id}`);
    doc.text(`Customer ID: ${data.customer_id}`);
    doc.text(`Insurance Company: ${data.insurance_company}`);
    doc.text(`Policy Number: ${data.policy_number}`);
    doc.text(`Policy Type: ${data.policy_type}`);
    doc.text(`Policy Amount: ₹ ${data.policy_amount}`);

    doc.moveDown(2);
    doc.text("Thank you for choosing our insurance service 🙏", { align: "center" });

    doc.end();

  });

});

app.get("/api/download-rto-pdf/:customerId", (req, res) => {

  const customerId = req.params.customerId;

  const sql = `
    SELECT *
    FROM rto_details
    WHERE customer_id = ?
    ORDER BY rto_id DESC
    LIMIT 1
  `;

  db.query(sql, [customerId], (err, rows) => {

    if (err) {
      console.log("❌ RTO PDF DB error:", err);
      return res.status(500).send("Database error");
    }

    if (rows.length === 0) {
      return res.status(404).send("RTO details not found");
    }

    const data = rows[0];
    const doc = new PDFDocument({ margin: 50 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline");

    doc.pipe(res);
    doc.fontSize(22).text("RTO RECEIPT", { align: "center" });
    doc.moveDown(2);

    doc.fontSize(14);

    doc.text(`RTO ID: ${data.rto_id}`);
    doc.text(`Customer ID: ${data.customer_id}`);
    doc.text(`Receipt Number: ${data.receipt_no}`);
    doc.text(`Registration Number: ${data.registration_no}`);
    doc.text(`Registration Date: ${data.registration_date}`);
    doc.text(`Registration Amount: ₹ ${data.registration_amount}`);

    doc.moveDown(2);
    doc.text("Vehicle Registration Completed Successfully 🚗", { align: "center" });

    doc.end();

  });

});

app.get("/api/view-rto-details/:customer_id", (req,res)=>{

  const customer_id = req.params.customer_id;

  const sql = `
    SELECT * FROM rto_details 
    WHERE customer_id = ?
    ORDER BY rto_id DESC
    LIMIT 1
  `;

  db.query(sql,[customer_id],(err,result)=>{
    if(err){
      console.log(err);
      return res.status(500).json(null);
    }

    if(result.length === 0){
      return res.json(null);
    }

    res.json(result[0]);
  });

});


app.get("/api/download-rto/:customer_id", (req, res) => {

  const customer_id = req.params.customer_id;

  db.query("SELECT * FROM rto_details WHERE customer_id=?", [customer_id], (err, result) => {
    if (err) {
      console.log(err);
      return res.status(500).send("DB Error");
    }

    if (result.length === 0) {
      return res.status(404).send("No RTO record found");
    }

    const rto = result[0];

    // 🔥 VERY IMPORTANT HEADERS (forces download)
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename=RTO_Receipt_${customer_id}.pdf`,
    });

    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res);

    // ===== PDF DESIGN =====
    doc.fontSize(22).fillColor("#7209b7").text("RTO PAYMENT RECEIPT", { align: "center" });
    doc.moveDown(2);

    doc.fillColor("black").fontSize(14);
    doc.text(`RTO ID : ${rto. rto_id}`);
    doc.text(`Customer ID : ${rto.customer_id}`);
    doc.text(`Receipt No : ${rto.receipt_no}`);
    doc.text(`Registration No : ${rto.registration_no}`);
    doc.text(`Registration Date : ${rto.registration_date.toISOString().split("T")[0]}`);
    doc.text(`Amount Paid : ₹${rto.registration_amount}`);
    doc.text(`Created At : ${rto.created_at}`);

    doc.moveDown(3);
    doc.text("This is a system generated receipt.", { align: "center" });

    doc.end(); // 🔥 MUST END STREAM
  });

});

app.get("/api/receipts/:bookingId", (req, res) => {

  const bookingId = req.params.bookingId;

  const sql = `
    SELECT 
      b.*,
      d.aadhaar_file,
      d.pan_file,
      d.receipt_file
    FROM bookings b
    LEFT JOIN booking_documents d
      ON b.booking_id = d.booking_id
    WHERE b.booking_id = ?
  `;

  db.query(sql, [bookingId], (err, result) => {

    if (err) {
      console.log("DB ERROR:", err);
      return res.status(500).json({ booking: null });
    }

    if (result.length === 0) {
      return res.json({ booking: null });
    }

    const row = result[0];

    // 🔥 Get latest payment receipt
    const paymentSql = `
      SELECT payment_id, receipt_file
      FROM payment_receipts
      WHERE booking_id = ?
      ORDER BY id DESC
      LIMIT 1
    `;

    db.query(paymentSql, [bookingId], (err2, payResult) => {

      if (err2) {
        console.log("Payment Error:", err2);
      }

      res.json({
        booking: {
          booking_id: row.booking_id,
          customer_id: row.customer_id,
          customer_name: row.customer_name,
          booking_status: row.booking_status
        },

        documents: {   // ✅ THIS WAS MISSING
          aadhaar_file: row.aadhaar_file,
          pan_file: row.pan_file,
          receipt_file: row.receipt_file
        },

        latest_payment: payResult.length > 0 ? payResult[0] : null
      });

    });

  });

});
app.get("/api/download-booking-pdf/:customerId", (req, res) => {

  const customerId = req.params.customerId;

  // Step 1: Get booking_id using customer_id
  const bookingSql = "SELECT booking_id FROM bookings WHERE customer_id = ?";

  db.query(bookingSql, [customerId], (err, bookingResult) => {

    if (err) {
      console.log(err);
      return res.status(500).send("Server error");
    }

    if (bookingResult.length === 0) {
      return res.status(404).send("Booking not found");
    }

    const bookingId = bookingResult[0].booking_id;

    // Step 2: Get uploaded documents
    const docSql = `
      SELECT aadhaar_file, pan_file, receipt_file 
      FROM booking_documents 
      WHERE booking_id = ?
    `;

    db.query(docSql, [bookingId], (err2, docResult) => {

      if (err2) {
        console.log(err2);
        return res.status(500).send("Server error");
      }

      if (docResult.length === 0) {
        return res.status(404).send("Documents not found");
      }

      const documents = docResult[0];

      // 👉 If you want to open receipt_file only:
      if (documents.receipt_file) {
        const filePath = __dirname + "/uploads/" + documents.receipt_file;
        return res.sendFile(filePath);
      } else {
        return res.status(404).send("Receipt file not uploaded");
      }

    });

  });

});
app.get("/api/download-payment-pdf/:customerId", (req, res) => {
  const doc = new PDFDocument();
  const customerId = req.params.customerId;
  console.log("Customer ID received:", customerId);

  const sql = `
    SELECT pr.receipt_file
    FROM payment_receipts pr
    JOIN bookings b ON pr.booking_id = b.booking_id
    WHERE b.customer_id = ?
    ORDER BY pr.id DESC
    LIMIT 1
  `;

  db.query(sql, [customerId], (err, result) => {
    if (err) {
      console.log("DB ERROR:", err);
      return res.status(500).send("Server error");
    }

    if (result.length === 0) {
      return res.status(404).send("Payment receipt not found");
    }

    const fileName = result[0].receipt_file;
    const filePath = path.join(__dirname, "uploads", fileName);

    res.sendFile(filePath, err => {
      if (err) console.log("File send error:", err);
    });
  });
});


app.get("/api/customer-full-details/:customerId", (req, res) => {
  

  const customerId = req.params.customerId;

  const sql = `
    SELECT 
      i.id AS insurance_id,
      i.insurance_company AS company,
      i.policy_number,
      i.policy_type,
      i.policy_amount AS insurance_amount,

      i.booking_id,
      b.vehicle_model,
      b.booking_date,
      b.booking_amount,

      inv.invoice_id

    FROM insurance_details i
    LEFT JOIN bookings b 
      ON i.booking_id = b.booking_id
    LEFT JOIN invoice_details inv 
      ON b.booking_id = inv.booking_id
    WHERE i.customer_id = ?
  `;
  db.query(sql, [customerId], (err, result) => {

    if (err) return res.status(500).send("Server error");
    if (result.length === 0) return res.status(404).send("No records found");

    res.json(result[0]);

  });

});
app.get("/api/invoice-receipts-all", (req, res) => {
  const doc = new PDFDocument();
  db.query("SELECT * FROM invoice_receipts", (err, result) => {
    if (err) return res.status(500).json([]);
    res.json(result);
  });
});/* ------------ DOWNLOAD INSURANCE PDF ------------ */



app.get("/api/download-insurance-pdf/:id", (req, res) => {
  const doc = new PDFDocument();
  const customerId = req.params.id;

  const query = "SELECT * FROM insurance_details WHERE customer_id = ?";

  db.query(query, [customerId], (err, results) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Database error");
    }

    if (results.length === 0) {
      return res.status(404).send("No record found");
    }

    const data = results[0];
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Insurance_${customerId}.pdf`
    );

    doc.pipe(res);

    doc.fontSize(20).text("Insurance Receipt", { align: "center" });
    doc.moveDown();

    doc.fontSize(14).text(`Insurance ID: ${data. insurance_id}`);
    doc.fontSize(14).text(`Customer ID: ${data.customer_id}`);
    doc.text(`Company: ${data.insurance_company}`);   // ✅ corrected
    doc.text(`Policy Number: ${data.policy_number}`);
    doc.text(`Policy Type: ${data.policy_type}`);
    doc.text(`Amount: ₹${data.policy_amount}`);       // ✅ corrected

    doc.end();
  });
});


app.get("/api/workflow-summary", (req, res) => {

const SLA = 1;

/* ================= SUMMARY SQL ================= */
const sql = `
SELECT 
department,

COUNT(*) AS total_count,

SUM(
CASE 
WHEN end_time IS NOT NULL 
AND TIMESTAMPDIFF(MINUTE,start_time,end_time)/1440 > ?
THEN 1 ELSE 0
END
) AS delayed_count,

SUM(
CASE 
WHEN end_time IS NULL 
     AND TIMESTAMPDIFF(MINUTE,start_time,NOW())/1440 <= ?
THEN 1 ELSE 0
END
) AS progress_count,

SUM(
CASE
WHEN end_time IS NULL 
     AND TIMESTAMPDIFF(MINUTE,start_time,NOW()) >= (? * 1440)
THEN 1 ELSE 0
END
) AS delayed_running_count,
SUM(
CASE 
WHEN end_time IS NOT NULL 
AND TIMESTAMPDIFF(MINUTE,start_time,end_time)/1440 <= ?
THEN 1 ELSE 0
END
) AS completed_count

FROM department_tat
GROUP BY department
`;

db.query(sql,[SLA,SLA,SLA,SLA],(err,rows)=>{

if(err){
console.log("Error:",err);
return res.status(500).json({});
}

/* ================= DEFAULT RESULT ================= */
let result={

Sales:{total:0,delayed:0,progress:0,completed:0},
Invoice:{total:0,delayed:0,progress:0,completed:0},
Insurance:{total:0,delayed:0,progress:0,completed:0},
RTO:{total:0,delayed:0,progress:0,completed:0},
Fastag:{total:0,delayed:0,progress:0,completed:0},
Delivery:{total:0,delayed:0,progress:0,completed:0},
VehicleAllotment:{total:0,delayed:0,progress:0,completed:0},

Accessories:{pending:0,completed:0},

Accounts:{pending:0,due:0,refund:0},
BookingCancelled:{progress:0,completed:0}

};

/* ================= MAP department_tat ================= */
rows.forEach(row=>{

let dept = row.department.trim();
if(dept.toLowerCase() === "fastag"){
  dept = "Fastag";
}

/* FIX NAME ISSUE */
if(dept === "Vehicle Allotment"){
  dept = "VehicleAllotment";
}

/* ACCESSORIES */
if(dept.toLowerCase() === "accessories"){
  result.Accessories.pending = row.progress_count;
  result.Accessories.completed = row.completed_count;
}

else if(dept === "Accounts"){
  // keep delayed from department_tat if needed
  result.Accounts.delayed =
    Number(row.delayed_count || 0) + Number(row.delayed_running_count || 0);
}

/* OTHER DEPARTMENTS */
else{
  result[dept] = {
  total: row.total_count,
  delayed: Number(row.delayed_count || 0) + Number(row.delayed_running_count || 0),
  progress: row.progress_count,
  completed: row.completed_count
};
}

});

/* ================= ACCOUNT STATUS (DUE / REFUND ONLY ACTIVE) ================= */

const accountSql = `
SELECT
SUM(CASE WHEN type='Due' AND end_time IS NULL THEN 1 ELSE 0 END) AS due_count,
SUM(CASE WHEN type='Refund' AND end_time IS NULL THEN 1 ELSE 0 END) AS refund_count
FROM account_status
`;

db.query(accountSql,(err,acc)=>{

if(!err && acc.length>0){
  result.Accounts.due = acc[0].due_count || 0;
  result.Accounts.refund = acc[0].refund_count || 0;
}


/* ================= BOOKING CANCELLED (REFUND STATUS) ================= */

const refundSql = `
SELECT
SUM(CASE WHEN status='Pending' THEN 1 ELSE 0 END) AS progress_count,
SUM(CASE WHEN status='Completed' THEN 1 ELSE 0 END) AS completed_count
FROM cancelled_booking_refunds
`;

db.query(refundSql,(err,refundRows)=>{

if(!err && refundRows.length > 0){
  result.BookingCancelled.progress = refundRows[0].progress_count || 0;
  result.BookingCancelled.completed = refundRows[0].completed_count || 0;
}


const tableSql=`

/* department_tat */
SELECT
customer_id,
booking_id,
department,
start_time,
end_time,

ROUND(
TIMESTAMPDIFF(MINUTE,start_time,IFNULL(end_time,NOW()))/1440,2
) AS tat_days,

CASE
WHEN end_time IS NULL 
     AND TIMESTAMPDIFF(MINUTE,start_time,NOW()) >= (? * 1440)
THEN 'Delayed'

WHEN end_time IS NULL 
THEN 'In Progress'

WHEN end_time IS NOT NULL 
     AND TIMESTAMPDIFF(MINUTE,start_time,end_time) > (? * 1440)
THEN 'Delayed'

ELSE 'Completed'
END AS status

FROM department_tat

UNION ALL

/* account_status (Due / Refund) */
SELECT
customer_id,
booking_id,
'Accounts' AS department,
created_at AS start_time,
end_time,
NULL AS tat_days,

CASE
WHEN end_time IS NULL THEN type
ELSE 'Completed'
END AS status

FROM account_status
UNION ALL

/* Booking Cancelled */
SELECT
customer_id,
booking_id,
'BookingCancelled' AS department,
created_at AS start_time,
CASE
  WHEN status='Completed' THEN updated_at
  ELSE NULL
END AS end_time,
NULL AS tat_days,
CASE
  WHEN status='Pending' THEN 'In Progress'
  ELSE status
END AS status
FROM cancelled_booking_refunds

ORDER BY start_time DESC
`;

db.query(tableSql,[SLA,SLA],(err,tableRows)=>{

if(err){
console.log(err);
tableRows=[];
}

const moveToDeliverySql = `
INSERT INTO department_tat (customer_id, booking_id, department, start_time)

SELECT DISTINCT dt.customer_id, dt.booking_id, 'Delivery', NOW()

FROM department_tat dt

WHERE dt.booking_id IS NOT NULL

/* ❌ STOP CANCELLED BOOKINGS FROM MOVING */
AND NOT EXISTS (
  SELECT 1 FROM bookings b
  WHERE b.booking_id = dt.booking_id
  AND b.booking_status = 'Cancelled'
)

/* ✅ ALL DEPARTMENTS COMPLETED */
AND NOT EXISTS (
  SELECT 1 FROM department_tat d2
  WHERE d2.customer_id = dt.customer_id
  AND d2.booking_id = dt.booking_id
  AND d2.department != 'Delivery'
  AND d2.end_time IS NULL
)

/* ❌ NO ACTIVE DUE / REFUND */
AND NOT EXISTS (
  SELECT 1 FROM account_status a
  WHERE a.customer_id = dt.customer_id
  AND a.booking_id = dt.booking_id
  AND a.end_time IS NULL
)

/* ❌ DELIVERY NOT ALREADY CREATED */
AND NOT EXISTS (
  SELECT 1 FROM department_tat d3
  WHERE d3.customer_id = dt.customer_id
  AND d3.booking_id = dt.booking_id
  AND d3.department = 'Delivery'
)
`;
db.query(moveToDeliverySql, ()=>{

/* FINAL RESPONSE */
res.json({
summary: result,
table: tableRows
});

});

});
});

});

});

});


app.post("/api/start-department", (req, res) => {
  const { customer_id, booking_id, department } = req.body;

  if (!customer_id || !booking_id || !department) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const currentTime = new Date();

  // 1️⃣ Check if department already exists
  const checkQuery = `
    SELECT id FROM department_tat
    WHERE booking_id = ? AND department = ?
  `;

  db.query(checkQuery, [booking_id, department], (err, rows) => {

    if (err) {
      console.error("Check error:", err);
      return res.status(500).json({ error: "Check failed" });
    }

    if (rows.length > 0) {
      return res.json({
        success: false,
        message: "Department already started"
      });
    }

    // 2️⃣ Close the currently running department
    const closeQuery = `
      UPDATE department_tat
      SET end_time = ?
      WHERE booking_id = ?
      AND customer_id = ?
      AND end_time IS NULL
    `;

    db.query(closeQuery, [currentTime, booking_id, customer_id], (errClose) => {

      if (errClose) {
        console.error("Close error:", errClose);
        return res.status(500).json({ error: "Close failed" });
      }

      // 3️⃣ Insert new department start
      const insertQuery = `
        INSERT INTO department_tat
        (customer_id, booking_id, department, start_time)
        VALUES (?, ?, ?, NOW())
      `;

      db.query(insertQuery, [customer_id, booking_id, department], (errInsert) => {

        if (errInsert) {
          console.error("Insert error:", errInsert);
          return res.status(500).json({ error: "Insert failed" });
        }

        res.json({
          success: true,
          message: department + " department started"
        });

      });

    });

  });

});
app.post("/api/end-department", (req, res) => {

  const { customer_id, booking_id, department } = req.body;

  if (!customer_id || !booking_id || !department) {
    return res.status(400).json({ message: "Missing fields" });
  }

  // 🔥 NEW GLOBAL CHECK (ADDED)
  const checkStatusQuery = `
    SELECT booking_status FROM bookings WHERE booking_id = ?
  `;

  db.query(checkStatusQuery, [booking_id], (errStatus, statusRows) => {

    if (errStatus) {
      console.error("Status check error:", errStatus);
      return res.status(500).json({ message: "Error checking status" });
    }

    if (
      statusRows.length > 0 &&
      statusRows[0].booking_status &&
      statusRows[0].booking_status.toLowerCase().trim() === "cancelled"
    ) {
      console.log("⛔ Booking already cancelled - stopping flow");
      return res.json({
        message: "Booking already cancelled, no further action"
      });
    }

    // 🔽🔽🔽 YOUR ORIGINAL CODE STARTS (UNCHANGED) 🔽🔽🔽

    console.log("Ending Department:", department);

    const sql = `
      UPDATE department_tat
      SET end_time = NOW()
      WHERE customer_id = ? 
      AND booking_id = ?
      AND department = ?
      AND end_time IS NULL
    `;

    db.query(sql, [customer_id, booking_id, department], (err, result) => {

      if (err) {
        console.error("Update Error:", err);
        return res.status(500).json({ message: "Error updating end time" });
      }

      if (result.affectedRows === 0) {
        return res.json({
          message: "End time already recorded or no active department found"
        });
      }

      const dept = department.toLowerCase();
      let nextDepartment = null;

      switch (dept) {

        case "sales":
          nextDepartment = "Accounts";
          break;

        case "accounts":

          const checkCancelQuery = `
           SELECT booking_status FROM bookings
            WHERE booking_id = ?
          `;

          db.query(checkCancelQuery, [booking_id], (errCheck, rows) => {

            if (errCheck) {
              console.error("Check cancel error:", errCheck);
              return res.status(500).json({ message: "Error checking status" });
            }

            if (
              rows.length > 0 &&
              rows[0].booking_status &&
              rows[0].booking_status.toLowerCase().trim() === "cancelled"
            ) {

              // 🔥 ADD: CLOSE ALL ACTIVE DEPARTMENTS
              const closeAllQuery = `
                UPDATE department_tat
                SET end_time = NOW()
                WHERE booking_id = ?
                AND end_time IS NULL
              `;

              db.query(closeAllQuery, [booking_id], (errClose) => {

                if (errClose) {
                  console.error("Close Error:", errClose);
                  return res.status(500).json({ message: "Error closing departments" });
                }

                // 🔥 UPDATED: BookingCancelled should be completed
                const insertQuery = `
                  INSERT INTO department_tat
                  (customer_id, booking_id, department, start_time, end_time)
                  VALUES (?, ?, 'BookingCancelled', NOW(), NOW())
                `;

                db.query(insertQuery, [customer_id, booking_id], (err2) => {

                  if (err2) {
                    console.error("Insert Error:", err2);
                    return res.status(500).json({ message: "Error starting BookingCancelled" });
                  }

                  return res.json({
                    message: "Accounts completed and BookingCancelled started"
                  });

                });

              });

            } else {

              const insertQuery = `
                INSERT INTO department_tat
                (customer_id, booking_id, department, start_time)
                VALUES (?, ?, 'Invoice', NOW())
              `;

              db.query(insertQuery, [customer_id, booking_id], (err2) => {

                if (err2) {
                  console.error("Insert Error:", err2);
                  return res.status(500).json({ message: "Error starting Invoice" });
                }

                return res.json({
                  message: "Accounts completed and Invoice started"
                });

              });

            }

          });

          return;

        case "invoice":
          nextDepartment = "Insurance";
          break;

        case "insurance":
          nextDepartment = "RTO";
          break;

        case "rto":
          nextDepartment = "Accessories";
          break;

        case "accessories":
          nextDepartment = "Delivery";
          break;

        case "bookingcancelled":
          return res.json({ message: "Booking is cancelled, flow stopped" });

      }

      console.log("Next Department:", nextDepartment);

      if (nextDepartment) {

        const insertQuery = `
          INSERT INTO department_tat
          (customer_id, booking_id, department, start_time)
          VALUES (?, ?, ?, NOW())
        `;

        db.query(insertQuery, [customer_id, booking_id, nextDepartment], (err2) => {

          if (err2) {
            console.error("Insert Error:", err2);
            return res.status(500).json({ message: "Error starting next department" });
          }

          res.json({
            message: `${department} completed and ${nextDepartment} started`
          });

        });

      } else {

        res.json({
          message: "Workflow completed or stopped"
        });

      }

    });

    // 🔼🔼🔼 YOUR ORIGINAL CODE ENDS 🔼🔼🔼

  });

});
app.post("/api/start-sales-session", (req, res) => {
    const sql = `
        INSERT INTO department_tat
    (customer_id, booking_id, department, start_time)
  VALUES (?, ?, ?, NOW())
  ON DUPLICATE KEY UPDATE start_time = start_time
`;

    db.query(sql, (err) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error starting session" });
        }
        res.json({ message: "Sales session started" });
    });
});
app.post("/api/end-sales-session", (req, res) => {
    const sql = `
        UPDATE department_tat
        SET end_time = NOW()
        WHERE department = 'Sales'
        AND end_time IS NULL
        ORDER BY id DESC
        LIMIT 1
    `;

    db.query(sql, (err) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error ending session" });
        }
        res.json({ message: "Sales session ended" });
    });
});

app.post("/add-accessories", upload.single("receipt"), (req,res)=>{

  console.log("ACCESSORIES API CALLED");

  const customer_id = req.body.customer_id.trim();
  const booking_id = req.body.booking_id.trim();
  const accessories_amount = req.body.accessories_amount;
  const accessories_number = req.body.accessories_number;
  const file = req.file ? req.file.filename : null;

  /* 🔹 CHECK BOOKING */
  db.query(
    `SELECT * FROM bookings WHERE booking_id=?`,
    [booking_id],
    (err, booking)=>{

      if(err) return res.json({status:"error"});

      if(booking.length === 0){
        return res.json({status:"booking_not_found"});
      }

      /* 🔹 CHECK CUSTOMER */
      db.query(
        `SELECT * FROM bookings WHERE TRIM(customer_id)=?`,
        [customer_id],
        (err, customer)=>{

          if(err) return res.json({status:"error"});

          if(customer.length === 0){
            return res.json({status:"customer_not_found"});
          }

          if(Number(booking[0].customer_id) !== Number(customer_id)){
            return res.json({status:"not_matching"});
          }

          const customer_name = booking[0].customer_name;

          /* 🔹 INSERT ACCESSORIES */
          db.query(
            `INSERT INTO accessories
            (accessories_number, customer_id, booking_id, accessories_amount, receipt_file)
            VALUES (?, ?, ?, ?, ?)`,
            [accessories_number, customer_id, booking_id, accessories_amount, file],
            (err)=>{

              if(err){
                console.log(err);
                return res.json({status:"error"});
              }

              db.query(
  `UPDATE accessories_refer
   SET status='Completed'
   WHERE TRIM(customer_id)=? AND TRIM(booking_id)=?`,
  [customer_id, booking_id],
  (err, result) => {

    if(err){
      console.log("UPDATE ERROR:", err);
    } else {
      console.log("Rows Updated:", result.affectedRows);
    }
  }
);

              /* 🔹 END ACCESSORIES TAT */
              db.query(
                `UPDATE department_tat
                 SET end_time = NOW()
                 WHERE customer_id=? 
                 AND booking_id=? 
                 AND department='Accessories'
                 AND end_time IS NULL`,
                [customer_id, booking_id]
              );

              /* 🔹 START ACCOUNTS (PAYMENT DASHBOARD) */
              db.query(
                `INSERT IGNORE INTO department_tat
                 (customer_id, booking_id, department, start_time)
                 VALUES (?, ?, 'Accounts', NOW())`,
                [customer_id, booking_id]
              );

              /* 🔹 ADD TO OTHER AMOUNT TABLE */
db.query(
  `INSERT IGNORE INTO other_refer
   (customer_id, booking_id, status)
   VALUES (?, ?, 'Pending')`,
  [customer_id, booking_id]
);

              return res.json({status:"success"});
            }
          );

        });

    });

});
app.get("/get-accessories", (req, res) => {

const insertQuery = `
INSERT INTO accessories_refer (customer_id, booking_id, status)
SELECT f.customer_id, f.booking_id, 'Pending'
FROM fastag_refer f
WHERE f.status='Completed'
AND NOT EXISTS (
    SELECT 1 FROM accessories_refer a 
    WHERE a.booking_id = f.booking_id
)
`;

db.query(insertQuery, (err) => {

if(err){
console.log(err);
}

// MAIN SELECT
const sql = `
SELECT ar.customer_id,
       ar.booking_id,
       ar.status,
       a.accessories_number,
       a.accessories_amount,
       a.receipt_file
FROM accessories_refer ar
LEFT JOIN accessories a
ON ar.booking_id = a.booking_id
ORDER BY ar.customer_id ASC, ar.booking_id ASC
`;

db.query(sql, (err, result) => {

if (err) {
console.log(err);
return res.json([]);
}

res.json(result);

});

});

});
app.post("/check-accessories", (req, res) => {

const { customer_id, booking_id } = req.body;

// 1️⃣ Check booking + customer match
const query = `
SELECT * 
FROM bookings
WHERE booking_id=? AND TRIM(customer_id)=?
`;

db.query(query, [booking_id, customer_id], (err, result) => {

if(err){
console.log(err);
return res.json({status:"server_error"});
}

// booking id exists?
const bookingCheck = `
SELECT * FROM bookings WHERE booking_id=?
`;

db.query(bookingCheck,[booking_id],(err,bookingResult)=>{

if(bookingResult.length === 0){
return res.json({status:"booking_not_found"});
}

// customer mismatch
if(result.length === 0){
return res.json({status:"not_matching"});
}

// 2️⃣ Check accessories completed
const accessoriesQuery = `
SELECT * FROM accessories
WHERE booking_id=? AND customer_id=?
`;

db.query(accessoriesQuery,[booking_id,customer_id],(err,accResult)=>{

if(accResult.length > 0){
return res.json({status:"already_completed"});
}

res.json({status:"ok"});

});

});

});

});

app.post("/update-accessories", upload.single("receipt"), (req,res)=>{

const {customer_id,booking_id,accessories_number,accessories_amount,final_amount} = req.body;

let receiptFile = null;

if(req.file){
receiptFile = req.file.filename;
}

let query;

if(receiptFile){

query = `
UPDATE accessories
SET accessories_number=?,
accessories_amount=?,
final_amount=?,
receipt_file=?
WHERE customer_id=? AND booking_id=?
`;

db.query(query,[accessories_number,accessories_amount,final_amount,receiptFile,customer_id,booking_id],(err,result)=>{

if(err){
console.log(err);
return res.json({status:"error"});
}

res.json({status:"success"});

});

}else{

query = `
UPDATE accessories
SET accessories_number=?,
accessories_amount=?,
final_amount=?
WHERE customer_id=? AND booking_id=?
`;

db.query(query,[accessories_number,accessories_amount,final_amount,customer_id,booking_id],(err,result)=>{

if(err){
console.log(err);
return res.json({status:"error"});
}

res.json({status:"success"});

});

}

});


app.get("/get-payment-summary/:booking_id", (req, res) => {

  const booking_id = req.params.booking_id;

  const sql = `
  SELECT 
      b.total_amount,
      b.booking_amount,
      IFNULL(SUM(p.amount_paid),0) AS paid_amount
  FROM bookings b
  LEFT JOIN payment_details p
      ON b.booking_id = p.booking_id
  WHERE b.booking_id = ?
  GROUP BY b.total_amount,b.booking_amount
  `;

  db.query(sql, [booking_id], (err, result) => {

    if (err) {
      console.log(err);
      return res.json({success:false});
    }

    const data = result[0];

    const totalPayment =
      (data.total_amount * 0.5) - data.booking_amount;

    const remaining =
      totalPayment - data.paid_amount;

    res.json({
      total_amount: data.total_amount,
      booking_amount: data.booking_amount,
      total_payment: totalPayment,
      paid_amount: data.paid_amount,
      remaining_amount: remaining > 0 ? remaining : 0
    });

  });

});

app.post("/api/create-booking", (req,res)=>{

const {
customer_id,
customer_name,
mobile_number,
vehicle_model,
booking_date,
booking_amount,
total_amount
} = req.body;

const bookingQuery = `
INSERT INTO bookings
(customer_id,customer_name,mobile_number,vehicle_model,booking_date,booking_amount,total_amount,booking_status)
VALUES (?,?,?,?,?,?,?,?)
`;

db.query(
bookingQuery,
[
customer_id,
customer_name,
mobile_number,
vehicle_model,
booking_date,
booking_amount,
total_amount,
"In Progress"
],
(err,result)=>{

if(err){
console.log(err);
return res.status(500).json({error:"Booking failed"});
}

const booking_id = result.insertId;

/* 🔥 AUTO START SALES */
const salesQuery = `
INSERT INTO department_tat
(customer_id,booking_id,department,start_time)
VALUES (?,?, 'Sales', NOW())
`;

db.query(salesQuery,[customer_id,booking_id],(err2)=>{

if(err2){
console.log(err2);
}

res.json({
success:true,
booking_id:booking_id
});

});

});

});
app.get("/api/get-final-amount/:customerId/:bookingId", (req,res)=>{

const customerId = req.params.customerId;
const bookingId = req.params.bookingId;

console.log("Customer:",customerId,"Booking:",bookingId);

/* BOOKING */

db.query(
`SELECT booking_amount,total_amount
 FROM bookings
 WHERE TRIM(customer_id)=? AND booking_id=?`,
[customerId,bookingId],
(err,booking)=>{

if(err){
console.log("Booking error:",err);
return res.json({success:false});
}

if(booking.length === 0){
console.log("No booking found");
return res.json({success:false});
}

let bookingAmount = Number(booking[0].booking_amount);
let totalAmount = Number(booking[0].total_amount);

/* Declare variables */

let paymentAmount = 0;
let invoiceAmount = 0;
let insuranceAmount = 0;
let rtoAmount = 0;
let fastagAmount = 0;
let accessoriesAmount = 0;

/* PAYMENT */

db.query(
`SELECT IFNULL(SUM(total_payment),0) AS total_payment
 FROM payment_refer
 WHERE TRIM(customer_id)=? AND booking_id=?`,
[customerId,bookingId],
(err,payment)=>{

if(!err && payment.length){
paymentAmount = Number(payment[0].total_payment);
}

console.log("Payment Amount:",paymentAmount);

/* INVOICE */

db.query(
`SELECT IFNULL(SUM(invoice_amount),0) AS invoice_amount
 FROM invoice_details
 WHERE TRIM(customer_id)=? AND booking_id=?`,
[customerId,bookingId],
(err,invoice)=>{

if(!err && invoice.length){
invoiceAmount = Number(invoice[0].invoice_amount);
}

console.log("Invoice Amount:",invoiceAmount);

/* INSURANCE */

db.query(
`SELECT IFNULL(SUM(policy_amount),0) AS policy_amount
 FROM insurance_details
 WHERE TRIM(customer_id)=?`,
[customerId],
(err,insurance)=>{

if(!err && insurance.length){
insuranceAmount = Number(insurance[0].policy_amount);
}

console.log("Insurance Amount:",insuranceAmount);

/* RTO */
db.query(
`SELECT IFNULL(SUM(registration_amount),0) AS registration_amount
 FROM rto_details
 WHERE TRIM(customer_id)=?`,
[customerId],
(err,rto)=>{

if(!err && rto.length){
  rtoAmount = Number(rto[0].registration_amount);
}

console.log("RTO Amount:",rtoAmount);

/* FASTAG */

db.query(
`SELECT IFNULL(SUM(amount),0) AS fastag_amount
 FROM fastag_details
 WHERE TRIM(customer_id)=? AND booking_id=?`,
[customerId, bookingId],
(err, fastag)=>{

if(!err && fastag.length){
fastagAmount = Number(fastag[0].fastag_amount);
}

console.log("FASTag Amount:", fastagAmount);
/* ACCESSORIES */

db.query(
`SELECT IFNULL(SUM(accessories_amount),0) AS accessories_amount
 FROM accessories
 WHERE TRIM(customer_id)=? AND booking_id=?`,
[customerId, bookingId],
(err, accessories)=>{

if(!err && accessories.length){
  accessoriesAmount = Number(accessories[0].accessories_amount);
}

console.log("Accessories Amount:", accessoriesAmount);

/* FINAL CALCULATION */

let baseAmount =
bookingAmount +
paymentAmount +
invoiceAmount +
insuranceAmount +
rtoAmount +
fastagAmount +
accessoriesAmount;   // ✅ ONLY ADD THIS

console.log("Base Amount:",baseAmount);

res.json({
  success:true,
  vehicleTotal: totalAmount,
  baseAmount: baseAmount
});

});

});
});

});

});

});
});
});
app.get("/api/account-status", (req, res) => {
  db.query("SELECT * FROM account_status", (err, rows) => {
    if(err) return res.status(500).json([]);
    res.json(rows);
  });
});

app.post("/add-vehicle-allotment", (req, res) => {

  const { allotementno, chassis_no, eng_no, customer_id, booking_id } = req.body;

  db.getConnection((err, connection) => {
    if (err) {
      console.error(err);
      return res.json({ status: "error" });
    }

    connection.beginTransaction((err) => {
      if (err) {
        connection.release();
        return res.json({ status: "error" });
      }

      // 1️⃣ CHECK DUPLICATE
      const checkSql = `
        SELECT * FROM vehicleallotment 
        WHERE customer_id = ? AND booking_id = ?
      `;

      connection.query(checkSql, [customer_id, booking_id], (err, rows) => {

        if (err) {
          return connection.rollback(() => {
            connection.release();
            res.json({ status: "error" });
          });
        }

        if (rows.length > 0) {
          return connection.rollback(() => {
            connection.release();
            res.json({ status: "exists", message: "Vehicle already allotted" });
          });
        }

        // 2️⃣ INSERT
        const insertSql = `
          INSERT INTO vehicleallotment 
          (allotementno, chassis_no, eng_no, customer_id, booking_id)
          VALUES (?, ?, ?, ?, ?)
        `;

        connection.query(insertSql,
          [allotementno, chassis_no, eng_no, customer_id, booking_id],
          (err) => {

            if (err) {
              return connection.rollback(() => {
                connection.release();
                res.json({ status: "error" });
              });
            }

            // 3️⃣ UPDATE REFER
            const updateRefer = `
              UPDATE vehicleallotment_refer
              SET status = 'Completed'
              WHERE customer_id = ? AND booking_id = ?
            `;

            connection.query(updateRefer, [customer_id, booking_id], (err) => {

              if (err) {
                return connection.rollback(() => {
                  connection.release();
                  res.json({ status: "error" });
                });
              }

              // 4️⃣ CLOSE TAT
              const closeTat = `
                UPDATE department_tat
                SET end_time = NOW()
                WHERE booking_id = ? 
                AND department = 'VehicleAllotment'
                AND end_time IS NULL
              `;

              connection.query(closeTat, [booking_id], (err) => {

                if (err) {
                  return connection.rollback(() => {
                    connection.release();
                    res.json({ status: "error" });
                  });
                }

                // 5️⃣ START INVOICE
                const insertTat = `
                  INSERT INTO department_tat 
                  (customer_id, booking_id, department, start_time)
                  SELECT ?, ?, 'Invoice', NOW()
                  WHERE NOT EXISTS (
                    SELECT 1 FROM department_tat
                    WHERE booking_id = ? AND department = 'Invoice'
                  )
                `;

                connection.query(insertTat, [customer_id, booking_id, booking_id], (err) => {

                  if (err) {
                    return connection.rollback(() => {
                      connection.release();
                      res.json({ status: "error" });
                    });
                  }

                  
                  const invoiceSql = `
                    INSERT INTO invoice_refer (customer_id, booking_id, status)
                    SELECT ?, ?, 'Pending'
                    WHERE NOT EXISTS (
                      SELECT 1 FROM invoice_refer
                      WHERE customer_id = ? AND booking_id = ?
                    )
                  `;

                  connection.query(invoiceSql,
                    [customer_id, booking_id, customer_id, booking_id],
                    (err) => {

                      if (err) {
                        return connection.rollback(() => {
                          connection.release();
                          res.json({ status: "error" });
                        });
                      }

                      // ✅ COMMIT
                      connection.commit((err) => {
                        if (err) {
                          return connection.rollback(() => {
                            connection.release();
                            res.json({ status: "error" });
                          });
                        }

                        connection.release();
                        res.json({ status: "success" });
                      });

                    }
                  );

                });

              });

            });

          }
        );

      });

    });

  });

});
app.get("/api/sync-vehicle-allotment", (req, res) => {

  const sql = `
  INSERT INTO vehicleallotment_refer (customer_id, booking_id, status)
  SELECT 
    p.customer_id,
    p.booking_id,
    'Pending'
  FROM payment_refer p
  WHERE p.status = 'Completed'

  AND NOT EXISTS (
    SELECT 1 
    FROM vehicleallotment_refer v
    WHERE v.customer_id = p.customer_id
    AND v.booking_id = p.booking_id
  )
  `;

  db.query(sql, (err, result) => {
    if (err) {
      console.log("❌ Sync Error:", err);
      return res.status(500).json({ success: false, error: err });
    }

    res.json({
      success: true,
      message: "Sync completed successfully",
      inserted: result.affectedRows
    });
  });

});
app.post("/api/complete-refund", (req,res)=>{

  const { customer_id, booking_id } = req.body;

  db.query(
    `SELECT * FROM account_status 
     WHERE booking_id=? AND type='Refund'`,
    [booking_id],
    (err, rows)=>{

      if(err) return res.json({error:err});

      if(rows.length === 0)
        return res.json({error:"Refund record not found"});

      const refundAmount = Number(rows[0].amount);

      // ⭐ CHECK IF REFUND COMPLETED
      if(refundAmount > 0){

        // mark refund completed
        db.query(
          `UPDATE account_status
           SET amount = 0
           WHERE booking_id=? AND type='Refund'`,
          [booking_id],
          ()=>{

            // close Accounts department
            db.query(
              `UPDATE department_tat
               SET end_time = NOW()
               WHERE booking_id=? 
               AND department='Accounts'
               AND end_time IS NULL`,
              [booking_id]
            );

            // start Delivery
            db.query(
              `INSERT IGNORE INTO department_tat
               (customer_id, booking_id, department, start_time)
               VALUES (?, ?, 'Delivery', NOW())`,
              [customer_id, booking_id]
            );

            // add to delivery table
            db.query(
              `INSERT INTO delivery_refer (customer_id, booking_id, status)
               VALUES (?, ?, 'Pending')
               ON DUPLICATE KEY UPDATE status='Pending'`,
              [customer_id, booking_id],
              (err2)=>{

                if(err2) return res.json({error:err2});

                res.json({success:true});
              }
            );

          }
        );

      }

    }

  );

});
app.get("/api/departments", (req, res) => {
  const sql = "SELECT DISTINCT department FROM users";

  db.query(sql, (err, result) => {
    if (err) {
      console.log("❌ SQL ERROR:", err);   // VERY IMPORTANT
      return res.status(500).json({
        error: err.message
      });
    }

    res.json(result);
  });
});
app.post("/api/add-user", (req, res) => {
  const { name, email, password, department, branch } = req.body;

  const sql = `
    INSERT INTO users (name, email, password, department, branch)
    VALUES (?, ?, ?, ?, ?)
  `;

  db.query(sql, [name, email, password, department, branch], (err, result) => {
    if (err) return res.status(500).json({ error: "Insert failed" });
    res.json({ success: true });
  });
});
app.get("/api/users", (req, res) => {
  const sql = "SELECT id, name, email,  department, branch FROM users";

  db.query(sql, (err, result) => {
    if (err) return res.status(500).json({ error: "Fetch failed" });
    res.json(result);
  });
});
app.put("/api/update-user/:id", (req, res) => {
  const userId = req.params.id;
  const { name, email,  department, branch } = req.body;

  const sql = `
    UPDATE users 
    SET name=?, email=?, department=?, branch=?
    WHERE id=?
  `;

  db.query(sql, [name, email, department, branch, userId], (err) => {
    if (err) return res.status(500).json({ error: "Database error" });
    res.json({ message: "User updated successfully" });
  });
});
app.delete("/api/delete-user/:id", (req, res) => {
  const userId = req.params.id;

  const sql = "DELETE FROM users WHERE id = ?";

  db.query(sql, [userId], (err, result) => {
    if (err) {
      console.error("Delete Error:", err);
      return res.status(500).json({ error: "Database error" });
    }

    res.json({ message: "User deleted successfully" });
  });
});

app.get("/api/branches", (req,res)=>{
  db.query("SELECT * FROM branches", (err,result)=>{
    if(err) return res.json(err);
    res.json(result);
  });
});

app.post("/api/add-branch", (req,res)=>{
  const { name, address } = req.body;

  db.query(
    "INSERT INTO branches (name,address) VALUES (?,?)",
    [name,address],
    (err,result)=>{
      if(err) return res.json(err);
      res.json({message:"Branch added"});
    }
  );
});

app.delete("/api/delete-branch/:id", (req,res)=>{
  db.query(
    "DELETE FROM branches WHERE id=?",
    [req.params.id],
    (err,result)=>{
      if(err) return res.json(err);
      res.json({message:"Deleted"});
    }
  );
});
// UPDATE BRANCH
app.put("/api/update-branch/:id", (req, res) => {

  const branchId = req.params.id;
  const { name, address } = req.body;

  if (!name) {
    return res.status(400).json({ message: "Branch name required" });
  }

  const query = `
    UPDATE branches
    SET name = ?, address = ?
    WHERE id = ?
  `;

  db.query(query, [name, address, branchId], (err, result) => {
    if (err) {
      console.error("Update Branch Error:", err);
      return res.status(500).json({ message: "Database error" });
    }

    res.json({ message: "Branch updated successfully" });
  });
});



app.get("/api/top-sales", (req, res) => {

  const filter = req.query.filter || "week";

  let condition = "";

  if(filter === "week"){
    condition = "YEARWEEK(booking_date, 1) = YEARWEEK(CURDATE(), 1)";
  }
  else if(filter === "month"){
    condition = "MONTH(booking_date) = MONTH(CURDATE()) AND YEAR(booking_date)=YEAR(CURDATE())";
  }
  else if(filter === "year"){
    condition = "YEAR(booking_date) = YEAR(CURDATE())";
  }

  const query = `
    SELECT vehicle_model, COUNT(*) as total
    FROM bookings
    WHERE booking_status = 'Completed'
    ${condition ? "AND " + condition : ""}
    GROUP BY vehicle_model
    ORDER BY total DESC
  `;

  db.query(query, (err, results) => {

    if(err){
      console.error(err);
      return res.status(500).json({ error: "DB error" });
    }

    res.json({
      list: results,
      top: results[0] || null
    });

  });

});
app.post("/api/add-fastag", (req, res) => {

  const { customer_id, booking_id, fastag_number, amount } = req.body;

  // validation
  if (!customer_id || !booking_id || !fastag_number || !amount) {
    return res.json({ status: "error", message: "All fields required" });
  }

  const query = `
    INSERT INTO fastag_details 
    (customer_id, booking_id, fastag_number, amount)
    VALUES (?, ?, ?, ?)
  `;

  db.query(query, [customer_id, booking_id, fastag_number, amount], (err, result) => {
    if (err) {
      console.log(err);
      return res.json({ status: "error", message: "DB Error" });
    }

    // ✅ 1️⃣ UPDATE fastag_refer → Completed
    db.query(
      `UPDATE fastag_refer 
       SET status = 'Completed' 
       WHERE customer_id = ? AND booking_id = ?`,
      [customer_id, booking_id],
      (err2) => {
        if (err2) {
          console.log(err2);
          return res.json({ status: "error" });
        }

        // ✅ 2️⃣ END FASTAG TAT
        db.query(
          `UPDATE department_tat
           SET end_time = NOW()
           WHERE customer_id = ? 
           AND booking_id = ?
           AND department = 'FASTag'
           AND end_time IS NULL`,
          [customer_id, booking_id]
        );

        // ✅ 3️⃣ START ACCESSORIES TAT
        db.query(
          `INSERT INTO department_tat
           (customer_id, booking_id, department, start_time)
           VALUES (?, ?, 'Accessories', NOW())
           ON DUPLICATE KEY UPDATE start_time = start_time`,
          [customer_id, booking_id]
        );

        // ✅ 4️⃣ MOVE TO accessories_refer
        db.query(
          `INSERT INTO accessories_refer (customer_id, booking_id, status)
           VALUES (?, ?, 'Pending')
           ON DUPLICATE KEY UPDATE status = 'Pending'`,
          [customer_id, booking_id],
          (err3) => {
            if (err3) {
              console.log(err3);
              return res.json({ status: "error" });
            }

            // ✅ FINAL RESPONSE
            res.json({
              status: "success",
              message: "FASTag saved & moved to Accessories"
            });
          }
        );

      }
    );

  });

});
app.get("/api/get-fastag", (req, res) => {

  // 🔁 Step 1: Move customers from RTO → FASTag (ONLY if completed)
  const insertQuery = `
    INSERT INTO fastag_refer (customer_id, booking_id, status)
    SELECT r.customer_id, r.booking_id, 'Pending'
    FROM rto_refer r
    WHERE r.status='Completed'
    AND NOT EXISTS (
      SELECT 1 FROM fastag_refer f 
      WHERE f.booking_id = r.booking_id
    )
  `;

  db.query(insertQuery, (err) => {

    if(err){
      console.log("Insert Error:", err);
    }

    // 📊 Step 2: Get FASTag data (with details if available)
    const sql = `
      SELECT f.customer_id,
             f.booking_id,
             f.status,
             d.fastag_number,
             d.amount
      FROM fastag_refer f
      LEFT JOIN fastag_details d
      ON f.booking_id = d.booking_id
      ORDER BY f.customer_id ASC
    `;

    db.query(sql, (err, result) => {

      if (err) {
        console.log("Fetch Error:", err);
        return res.json([]);
      }

      res.json(result);

    });

  });

});
app.post("/api/save-other-amount", (req, res) => {

  const { customer_id, booking_id, other_amount } = req.body;

  /* ================= GET VEHICLE + BASE ================= */

  const sql = `
    SELECT 
      b.total_amount,
      b.customer_name,

      /* BASE CALCULATION */
      (
        IFNULL(b.booking_amount,0) +

        (SELECT IFNULL(SUM(total_payment),0)
         FROM payment_refer
         WHERE customer_id=? AND booking_id=?) +

        (SELECT IFNULL(SUM(invoice_amount),0)
         FROM invoice_details
         WHERE customer_id=? AND booking_id=?) +

        (SELECT IFNULL(SUM(policy_amount),0)
         FROM insurance_details
         WHERE customer_id=?) +

        (SELECT IFNULL(SUM(registration_amount),0)
         FROM rto_details
         WHERE customer_id=?) +

        (SELECT IFNULL(SUM(amount),0)
         FROM fastag_details
         WHERE customer_id=? AND booking_id=?) +

        (SELECT IFNULL(SUM(accessories_amount),0)
         FROM accessories
         WHERE customer_id=? AND booking_id=?)

      ) AS baseAmount

    FROM bookings b
    WHERE b.customer_id=? AND b.booking_id=?
  `;

  db.query(sql, [
    customer_id, booking_id,  // payment
    customer_id, booking_id,  // invoice
    customer_id,              // insurance
    customer_id,              // rto
    customer_id, booking_id,  // fastag
    customer_id, booking_id,  // accessories
    customer_id, booking_id   // main
  ], (err, result) => {

    if (err) {
      console.log(err);
      return res.json({ status: "error" });
    }

    if (result.length === 0) {
      return res.json({ status: "not_found" });
    }

    const vehicleTotal = Number(result[0].total_amount);
    const customer_name = result[0].customer_name;
    const baseAmount = Number(result[0].baseAmount);

    /* ================= FINAL AMOUNT ================= */

    const finalAmount = baseAmount + Number(other_amount);

    /* ================= SAVE ================= */

    const insertOther = `
      INSERT INTO other_amount
      (customer_id, booking_id, other_amount, final_amount)
      VALUES (?, ?, ?, ?)
    `;

    db.query(insertOther,
      [customer_id, booking_id, other_amount, finalAmount],
      (err) => {

        if (err) {
          console.log(err);
          return res.json({ status: "insert_error" });
        }

        /* ================= UPDATE STATUS (IMPORTANT) ================= */

        db.query(`
          UPDATE other_refer
          SET status='Completed'
          WHERE customer_id=? AND booking_id=?
        `, [customer_id, booking_id]);

        /* ================= COMPARE ================= */

        // 🔴 REFUND
        if (finalAmount > vehicleTotal) {

          const refund = finalAmount - vehicleTotal;

          db.query(`
            INSERT INTO account_status
            (customer_id, booking_id, customer_name, type, amount)
            VALUES (?, ?, ?, 'Refund', ?)
          `, [customer_id, booking_id, customer_name, refund]);

          return res.json({
            status: "refund",
            refund_amount: refund
          });
        }

        // 🟡 DUE
        else if (finalAmount < vehicleTotal) {

          const due = vehicleTotal - finalAmount;

          db.query(`
            INSERT INTO account_status
            (customer_id, booking_id, customer_name, type, amount)
            VALUES (?, ?, ?, 'Due', ?)
          `, [customer_id, booking_id, customer_name, due]);

          return res.json({
            status: "due",
            due_amount: due
          });
        }

        // 🟢 EXACT MATCH
        else {

          db.query(`
            INSERT IGNORE INTO department_tat
            (customer_id, booking_id, department, start_time)
            VALUES (?, ?, 'Delivery', NOW())
          `, [customer_id, booking_id]);

          db.query(`
            INSERT IGNORE INTO delivery_refer
            (customer_id, booking_id, status)
            VALUES (?, ?, 'Pending')
          `, [customer_id, booking_id]);

          return res.json({
            status: "completed"
          });
        }

      });

  });

});
app.get("/api/get-other-list", (req,res)=>{

  db.query(
    `SELECT * FROM other_refer`,
    (err,rows)=>{
      if(err) return res.json([]);
      res.json(rows);
    }
  );

});
app.get("/api/get-other-details/:customer_id/:booking_id", (req,res)=>{

  const { customer_id, booking_id } = req.params;

  const sql = `
    SELECT 
      b.total_amount,

      (
        IFNULL(b.booking_amount,0) +

        (SELECT IFNULL(SUM(total_payment),0)
         FROM payment_refer
         WHERE customer_id=? AND booking_id=?) +

        (SELECT IFNULL(SUM(invoice_amount),0)
         FROM invoice_details
         WHERE customer_id=? AND booking_id=?) +

        (SELECT IFNULL(SUM(policy_amount),0)
         FROM insurance_details
         WHERE customer_id=?) +

        (SELECT IFNULL(SUM(registration_amount),0)
         FROM rto_details
         WHERE customer_id=?) +

        (SELECT IFNULL(SUM(amount),0)
         FROM fastag_details
         WHERE customer_id=? AND booking_id=?) +

        (SELECT IFNULL(SUM(accessories_amount),0)
         FROM accessories
         WHERE customer_id=? AND booking_id=?)

      ) AS baseAmount

    FROM bookings b
    WHERE b.customer_id=? AND b.booking_id=?
  `;

  db.query(sql,[
    customer_id, booking_id,
    customer_id, booking_id,
    customer_id,
    customer_id,
    customer_id, booking_id,
    customer_id, booking_id,
    customer_id, booking_id
  ], (err,result)=>{

    if(err) return res.json({status:"error"});

    res.json(result[0]);

  });

});
app.use((req, res) => {
  res.status(404).send("Not Found");
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
