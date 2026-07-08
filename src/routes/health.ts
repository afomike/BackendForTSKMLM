import { Router, type Request } from "express";

interface HealthResponse {
  status(code: number): {
    json(body: unknown): void;
  };
}

const router = Router();

router.get("/healthz", (_req: Request, res: HealthResponse) => {
  res.status(200).json({
    status: "ok",
  });
});

export default router;