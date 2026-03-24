const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const cors = require("cors");
const dns = require("dns").promises;
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// ✅ ROOT ROUTE
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const upload = multer({ dest: "uploads/" });

// ✅ FORMAT CHECK
function isValidFormat(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ✅ ROLE EMAIL
function isRole(email) {
  return /^(info|admin|support|sales|contact)/i.test(email);
}

// ✅ LOAD DISPOSABLE DOMAINS
let disposableSet = new Set();

async function loadDisposableList() {
  try {
    const res = await axios.get(
      "https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf",
    );

    disposableSet = new Set(
      res.data
        .split("\n")
        .map((d) => d.trim())
        .filter(Boolean),
    );

    console.log("✅ Disposable domains loaded:", disposableSet.size);
  } catch (err) {
    console.log("❌ Failed to load disposable list");
  }
}

loadDisposableList();

// ✅ CHECK DISPOSABLE
function isDisposable(email) {
  const domain = email.split("@")[1];
  return disposableSet.size > 0 && disposableSet.has(domain);
}

// ✅ MX CACHE (⚡ performance boost)
let domainCache = {};

// ✅ MX CHECK
async function hasMX(domain) {
  try {
    const records = await dns.resolveMx(domain);
    return records && records.length > 0;
  } catch {
    return false;
  }
}

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    let results = [];
    let cleanedRows = [];
    let seen = new Set();

    for (let i = 0; i < data.length; i++) {
      let row = data[i];
      let keys = Object.keys(row);

      let emailKey = keys.find((k) => k.toLowerCase().includes("email"));
      let email = emailKey ? row[emailKey].trim().toLowerCase() : "";
      let rowNumber = i + 2;

      let status = "valid";
      let reason = "Safe";
      let score = 100;

      if (!email) {
        status = "invalid";
        reason = "No email";
        score = 0;
      } else if (!isValidFormat(email)) {
        status = "invalid";
        reason = "Bad format";
        score = 0;
      } else if (seen.has(email)) {
        status = "duplicate";
        reason = "Duplicate";
        score = 40;
      } else {
        let domain = email.split("@")[1];

        // ⚡ MX CACHE
        let mxValid;
        if (domainCache[domain] !== undefined) {
          mxValid = domainCache[domain];
        } else {
          mxValid = await hasMX(domain);
          domainCache[domain] = mxValid;
        }

        if (!mxValid) {
          status = "invalid";
          reason = "No MX records";
          score = 0;
        }

        if (isDisposable(email)) {
          status = "invalid";
          reason = "Disposable email";
          score = 0;
        }

        if (isRole(email)) {
          score -= 20;
          reason = "Role-based";
        }

        if (mxValid) {
          score -= 10;
        }
      }

      if (email) seen.add(email);

      // FINAL STATUS
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

      if (score >= 50) {
        cleanedRows.push({
          ...row,
          Validation_Status: status,
          Score: score,
        });
      }
    }

    // ✅ CREATE CLEAN FILE
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
    };

    res.json({
      summary,
      results,
      download: "/download",
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// DOWNLOAD
app.get("/download", (req, res) => {
  const filePath = path.join(__dirname, "cleaned_emails.xlsx");
  res.download(filePath);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Server running on port", PORT));