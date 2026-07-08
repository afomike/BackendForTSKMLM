import { Router } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import coursesRouter from "./courses.js";
import lessonsRouter from "./lessons.js";
import progressRouter from "./progress.js";
import usersRouter from "./users.js";
import statsRouter from "./stats.js";
import storageRouter from "./storage.js";
import settingsRouter from "./settings.js";
import quizzesRouter from "./quizzes.js";

const router = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(coursesRouter);
router.use(lessonsRouter);
router.use(progressRouter);
router.use(usersRouter);
router.use(statsRouter);
router.use(storageRouter);
router.use(settingsRouter);
router.use(quizzesRouter);

export default router;
