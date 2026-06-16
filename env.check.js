import dotenv from "dotenv";
dotenv.config();

const requiredVars = [
  "PORT",
  "NODE_ENV",
  "CLIENT_URL",
  "MONGODB_URI",
  "SENDGRID_API_KEY",
  "EMAIL_FROM",
];

console.log("=== ENV VALIDATION START ===\n");

let hasError = false;

for (const key of requiredVars) {
  const value = process.env[key];

  if (!value) {
    console.log(`❌ MISSING: ${key}`);
    hasError = true;
  } else {
    console.log(`✅ OK: ${key}`);
  }
}

console.log("\n=== DETAIL CHECK ===");

if (process.env.MONGODB_URI) {
  const ok = process.env.MONGODB_URI.startsWith("mongodb");
  console.log(ok ? "✅ MongoDB URI valid" : "❌ MongoDB URI invalid");
}

if (process.env.SENDGRID_API_KEY) {
  const ok = process.env.SENDGRID_API_KEY.startsWith("SG.");
  console.log(ok ? "✅ SendGrid key valid" : "❌ SendGrid key invalid");
}

console.log("\n=== FINAL RESULT ===");

if (hasError) {
  console.log("❌ ENV CHECK FAILED");
  process.exit(1);
} else {
  console.log("✅ ALL ENV VARIABLES OK");
}