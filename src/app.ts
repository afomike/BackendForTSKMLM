import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

const app = express();

/**
 * CORS Configuration
 */
const corsOptions = {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void
  ) => {
    const allowedOrigins = [
      "http://localhost:3000",
      "http://localhost:5173",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:5173",
      "https://seed-sower-lmc.vercel.app",
    ];

    // Allow requests without Origin header
    // (Postman, mobile apps, backend services)
    if (!origin) {
      return callback(null, true);
    }

    // Allow configured frontend URL
    if (process.env.FRONTEND_URL) {
      allowedOrigins.push(process.env.FRONTEND_URL);
    }

    // Allow Vercel preview deployments
    if (
      allowedOrigins.includes(origin) ||
      origin.endsWith(".vercel.app")
    ) {
      return callback(null, true);
    }

    console.log("Blocked CORS request from:", origin);

    return callback(null, false);
  },

  credentials: true,

  methods: [
    "GET",
    "HEAD",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
  ],

  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Accept",
    "X-Requested-With",
  ],

  optionsSuccessStatus: 204,
};


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
 * CORS Middleware
 * MUST come before routes
 */
app.use(cors(corsOptions));

/**
 * Express 5 compatible OPTIONS handler
 * Handles browser preflight requests
 */
app.options("/{*any}", cors(corsOptions));


/**
 * Body Parsers
 */
app.use(express.json());

app.use(
  express.urlencoded({
    extended: true,
  })
);


/**
 * API Routes
 */
app.use("/api", router);


/**
 * 404 Handler
 */
app.use((req, res) => {
  res.status(404).json({
    message: "Route not found",
  });
});


/**
 * Global Error Handler
 */
app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {

    logger.error(err);

    res.status(err.status || 500).json({
      message:
        err.message || "Internal server error",
    });
  }
);


export default app;