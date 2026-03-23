const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const upload = multer({ dest: "uploads/" });

const API_KEY = process.env.API_KEY;
console.log("ENV CHECK:", Object.keys(process.env));
console.log("API KEY:", API_KEY);
if (!API_KEY) {
  console.log("❌ API KEY MISSING - CHECK RAILWAY VARIABLES");
}

// ✅ Format check
function isValidFormat(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ✅ Role-based emails
function isRole(email) {
  return /^(info|admin|support|sales|contact)@/i.test(email);
}

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];

    const data = XLSX.utils.sheet_to_json(sheet, {
      defval: "",
      raw: false,
    });

    let results = [];
    let cleanedRows = []; // 🔥 for export
    let seen = new Set();

    for (let i = 0; i < data.length; i++) {
      let row = data[i];
      let keys = Object.keys(row);

      let emailKey = keys.find((k) => k.toLowerCase().includes("email"));

      let email = emailKey ? row[emailKey].trim() : "";
      let rowNumber = i + 2;

      let status = "valid";
      let reason = "Safe to send";
      let score = 100;

      // 🔴 BASIC CHECKS
      if (!email) {
        status = "invalid";
        reason = "No email in this row";
        score = 0;
      } else if (!isValidFormat(email)) {
        status = "invalid_format";
        reason = "Wrong email format";
        score = 0;
      } else if (seen.has(email)) {
        status = "duplicate";
        reason = "Duplicate email";
        score = 50;
      } else if (isRole(email)) {
        status = "risky";
        reason = "Role-based email";
        score -= 30;
      } else {
        try {
          let response = await axios.get(
            `https://api.zerobounce.net/v2/validate?api_key=${API_KEY}&email=${email}`,
            { timeout: 5000 },
          );

          let apiData = response.data;
          console.log(response.data);

          if (apiData.disposable === true) {
            status = "invalid";
            reason = "Disposable email";
            score = 0;
          } else if (apiData.abuse === true) {
            status = "risky";
            reason = "Possible spam trap";
            score -= 50;
          } else if (apiData.status === "invalid") {
            if (email.includes("vsnl.net.in") || email.includes(".in")) {
              status = "risky";
              reason = "Server not verifiable";
              score -= 50;
            } else {
              status = "invalid";
              reason = "Mailbox does not exist";
              score = 0;
            }
          } else if (apiData.status === "catch-all") {
            status = "risky";
            reason = "Catch-all";
            score -= 35;
          } else if (apiData.status === "valid") {
            if (apiData.sub_status && apiData.sub_status !== "") {
              status = "risky";
              reason = `Sub-status: ${apiData.sub_status}`;
              score -= 25;
            } else {
              status = "valid";
              reason = "Safe to send";
            }
          } else {
            status = "risky";
            reason = "Unknown response";
          }
        } catch (err) {
          console.log("API ERROR:", err.response?.data || err.message);
          status = "error";
          reason = "API failed";
        }
      }

      if (email) seen.add(email);

      // 🔥 FINAL CLASSIFICATION
      if (score >= 80) status = "valid";
      else if (score >= 50) status = "risky";
      else status = "invalid";

      results.push({
        email: email || "—",
        status,
        reason,
        score,
        row: rowNumber,
      });

      // 🔥 FILTER FOR CLEAN FILE
      if (score >= 50) {
        cleanedRows.push({
          ...row,
          Validation_Status: status,
          Score: score,
        });
      }
    }

    // 🔥 CREATE NEW EXCEL FILE
    const newSheet = XLSX.utils.json_to_sheet(cleanedRows);
    const newWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(newWorkbook, newSheet, "Cleaned Data");

    const filePath = path.join(__dirname, "cleaned_emails.xlsx");
    XLSX.writeFile(newWorkbook, filePath);

    let summary = {
      valid: results.filter((r) => r.status === "valid").length,
      invalid: results.filter((r) => r.status === "invalid").length,
      risky: results.filter((r) => r.status === "risky").length,
      duplicate: results.filter((r) => r.status === "duplicate").length,
      empty: results.filter((r) => r.reason === "No email in this row").length,
    };

    res.json({
      summary,
      results,
      download: "http://localhost:3000/download", // 🔥 send link
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// 🔥 DOWNLOAD ROUTE
app.get("/download", (req, res) => {
  const filePath = path.join(__dirname, "cleaned_emails.xlsx");
  res.download(filePath);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
