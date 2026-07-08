import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

const app = express();

// CORS configuration
const getCorsOptions = () => {
  const nodeEnv = process.env["NODE_ENV"] ?? "development";

  const origins: string[] = [];

  // Allow localhost during development
  if (nodeEnv === "development") {
    origins.push(
      "http://localhost:3000",
      "http://localhost:5173",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:5173"
    );
  }

  // Allow Vercel frontend and any FRONTEND_URL configured
  const vercelFrontend = "https://seed-sower-lmc.vercel.app";
  origins.push(vercelFrontend);
  if (process.env.FRONTEND_URL) {
    origins.push(process.env.FRONTEND_URL);
  }

  const allowedOrigins = Array.from(new Set(origins.filter(Boolean)));

  const corsOptions = {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Allow non-browser or same-origin requests with no Origin header
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"] as string[],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"] as string[],
    optionsSuccessStatus: 204,
  };

  return corsOptions;
};

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
  }),
);

// CORS must be before routes
const corsOptions = getCorsOptions();
app.use(cors(corsOptions));

// Ensure explicit preflight handling for all routes
app.options("*", cors(corsOptions));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;