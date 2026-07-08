import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

const app = express();

/**
 * Trust Render's proxy so req.secure / req.ip etc. work correctly
 */
app.set("trust proxy", 1);

/**
 * CORS Configuration
 */
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
  "https://seed-sower-lmc.vercel.app",
];

if (process.env.FRONTEND_URL) {
  allowedOrigins.push(process.env.FRONTEND_URL.replace(/\/$/, ""));
}

const corsOptions: cors.CorsOptions = {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void
  ) => {
    // Allow requests without an Origin header
    // (curl, Postman, server-to-server, some mobile clients)
    if (!origin) {
      return callback(null, true);
    }

    const normalizedOrigin = origin.replace(/\/$/, "");

    const isAllowed =
      allowedOrigins.includes(normalizedOrigin) ||
      normalizedOrigin.endsWith(".vercel.app");

    if (isAllowed) {
      return callback(null, true);
    }

    logger.warn(`Blocked CORS request from origin: ${origin}`);
    return callback(null, false);
  },

  credentials: true,

  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],

  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Accept",
    "X-Requested-With",
  ],

  optionsSuccessStatus: 204,
};

/**
 * CORS Middleware
 * MUST come before routes.
 * app.use(cors(...)) alone handles OPTIONS preflight automatically —
 * no need for a separate app.options(...) wildcard route.
 */
app.use(cors(corsOptions));

/**
 * HTTP Request Logger
 */
app.use(
  (pinoHttp as any)({
    logger,
    serializers: {
      req(req: any) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res: any) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  })
);

/**
 * Body Parsers
 */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// in  as a top-level route
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

/**
 * API Routes
 */
app.use("/api", router);

/**
 * 404 Handler
 */
app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

/**
 * Global Error Handler
 * IMPORTANT: this must have 4 params for Express to recognize it as
 * an error handler, and must come last.
 */
app.use(
  (err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error(err);
    res.status(err.status || 500).json({
      message: err.message || "Internal server error",
    });
  }
);

export default app;