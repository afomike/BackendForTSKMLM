import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

const app = express();

// CORS configuration
const getCorsOptions = () => {
  const nodeEnv = process.env["NODE_ENV"] ?? "development";
  const frontendUrl = process.env["FRONTEND_URL"];

  const origins: string[] = [];

  // Always allow localhost in development
  if (nodeEnv === "development") {
    origins.push("http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000", "http://127.0.0.1:5173");
  }

  // Add configured frontend URL if provided
  if (frontendUrl) {
    origins.push(frontendUrl);
  }

  return {
    origin: origins.length > 0 ? origins : true, // Allow all if no specific origins configured
    credentials: true,
  };
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
app.use(cors(getCorsOptions()));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
