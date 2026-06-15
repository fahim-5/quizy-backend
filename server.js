import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";
import { setIo } from "./utils/socket.js";
import mongoose from "mongoose";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import mongoSanitize from "express-mongo-sanitize";
import dotenv from "dotenv";
import connectDB from "./config/database.js";

// Import routes
import routes from "./routes/index.js";
import listEndpoints from "express-list-endpoints";
import errorHandler from "./middleware/errorHandler.js";

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Colors for console logs
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
};

// Security Middleware
app.use(helmet());
app.use(mongoSanitize());
// CORS: build an allowlist from env vars and sensible defaults.
// Use `ALLOWED_ORIGINS` (comma-separated) or `CLIENT_URL` to add origins.
// In development we remain permissive.
const DEFAULT_NETLIFY = "https://quizy-online-quize-platfrom.netlify.app";
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
const allowedOrigins = new Set();

// helper to add origin variants
const addOrigin = (u) => {
  if (!u) return;
  allowedOrigins.add(u);
  if (u.includes("localhost"))
    allowedOrigins.add(u.replace("localhost", "127.0.0.1"));
};

addOrigin(CLIENT_URL);
addOrigin(DEFAULT_NETLIFY);

if (process.env.ALLOWED_ORIGINS) {
  process.env.ALLOWED_ORIGINS.split(",").forEach((s) => addOrigin(s.trim()));
}

const isOriginAllowed = (origin) => {
  // allow non-browser tools (no origin)
  if (!origin) return true;
  return allowedOrigins.has(origin);
};

const corsOptions = {
  origin: (origin, cb) => cb(null, isOriginAllowed(origin)),
  credentials: true,
  optionsSuccessStatus: 200,
};

// In development, be permissive so browsers like Firefox can hit the API during local testing.
if (process.env.NODE_ENV !== "production") {
  app.use(
    cors({
      origin: true,
      credentials: true,
      optionsSuccessStatus: 200,
    }),
  );
  app.options("*", cors({ origin: true, credentials: true }));
} else {
  app.use(cors(corsOptions));
  // Enable preflight for all routes with same options
  app.options("*", cors(corsOptions));
}

// Rate limiting: apply global limiter but skip auth endpoints to avoid blocking login flows during development
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  // don't apply global limit to auth routes (login/register) to avoid accidental 429 during testing
  skip: (req) => {
    try {
      const p = req.path || "";
      return p.startsWith("/api/auth");
    } catch (e) {
      return false;
    }
  },
});
app.use(limiter);

// Body parsing middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Static files (other public assets served from /public if needed)

// Routes
app.use("/api", routes);

// Welcome route
app.get("/", (req, res) => {
  res.json({
    message: "🎉 Welcome to Express MVC Backend!",
    version: "1.0.0",
    status: "🟢 Running",
    documentation: "/api/docs",
    endpoints: {
      auth: "/api/auth",
      users: "/api/users",
      posts: "/api/posts",
    },
  });
});

// Health check route
app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "✅ Server is healthy and running!",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    message: `❌ Route ${req.originalUrl} not found`,
  });
});

// Error handling middleware
app.use(errorHandler);

// Database connection is handled centrally in `backend/config/database.js`.

// Start server with port fallback: try configured PORT, then next ports if in use
const startServer = async () => {
  try {
    await connectDB();

    const basePort = Number(process.env.PORT) || PORT || 5000;
    const maxAttempts = 10;
    let currentPort = basePort;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await new Promise((resolve, reject) => {
          const httpServer = http.createServer(app);
          const io = new IOServer(httpServer, {
            cors: {
              origin: (origin, cb) => cb(null, isOriginAllowed(origin)),
              credentials: true,
            },
          });

          // Save io for controllers
          setIo(io);

          io.on("connection", (socket) => {
            // join a quiz room when requested by client
            socket.on("monitor:join", (quizId) => {
              try {
                socket.join(`quiz-${quizId}`);
              } catch (e) {}
            });
          });

          const server = httpServer.listen(currentPort, () => {
            console.log(
              `\n${colors.green}🚀 ${colors.bright}Server Started Successfully!${colors.reset}`,
            );
            console.log(
              `   ${colors.cyan}📍 Port:${colors.reset} ${colors.yellow}${currentPort}${colors.reset}`,
            );
            console.log(
              `   ${colors.cyan}🌍 Environment:${colors.reset} ${colors.yellow}${process.env.NODE_ENV || "development"}${colors.reset}`,
            );
            console.log(
              `   ${colors.cyan}🔗 Local URL:${colors.reset} ${colors.blue}http://localhost:${currentPort}${colors.reset}`,
            );
            console.log(
              `   ${colors.cyan}📚 API Base:${colors.reset} ${colors.blue}http://localhost:${currentPort}/api${colors.reset}`,
            );
            console.log(
              `   ${colors.green}✅ Server is ready to accept requests!${colors.reset}`,
            );

            // Display available routes
            console.log(
              `\n${colors.magenta}📋 Available Routes:${colors.reset}`,
            );
            const endpoints = listEndpoints(app);
            endpoints.forEach((ep) => {
              const methods = ep.methods.join(",");
              console.log(
                `   ${colors.cyan}${methods.padEnd(6)} ${colors.reset}${ep.path}`,
              );
            });
            console.log(
              `\n${colors.green}🎯 Use Ctrl+C to stop the server${colors.reset}\n`,
            );

            resolve();
          });

          server.on("error", (err) => {
            reject(err);
          });
        });

        // successful listen
        break;
      } catch (err) {
        if (err && err.code === "EADDRINUSE") {
          console.log(
            `${colors.yellow}Port ${currentPort} in use, trying ${currentPort + 1}${colors.reset}`,
          );
          currentPort += 1;
          continue;
        }
        throw err;
      }
    }
  } catch (error) {
    console.log(
      `\n${colors.red}💥 ${colors.bright}Failed to start server!${colors.reset}`,
    );
    console.log(`   ${colors.red}Error:${colors.reset} ${error.message}\n`);
    process.exit(1);
  }
};

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log(
    `\n${colors.yellow}👋 ${colors.bright}Shutting down server gracefully...${colors.reset}`,
  );

  try {
    await mongoose.connection.close();
    console.log(
      `   ${colors.green}✅ MongoDB connection closed.${colors.reset}`,
    );
    console.log(
      `   ${colors.green}✅ Server stopped successfully.${colors.reset}\n`,
    );
    process.exit(0);
  } catch (error) {
    console.log(
      `   ${colors.red}❌ Error during shutdown:${colors.reset} ${error.message}`,
    );
    process.exit(1);
  }
});

// Start the application
startServer();
