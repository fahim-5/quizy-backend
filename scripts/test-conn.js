import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI not set in environment");
  process.exit(1);
}

(async () => {
  try {
    const conn = await mongoose.connect(uri, { dbName: "onlinequizplatfrom" });
    console.log(
      "Mongo OK - connected to",
      conn.connection.host,
      "db:",
      conn.connection.name,
    );
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("Mongo ERR", err && err.message ? err.message : err);
    process.exit(2);
  }
})();
