import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import accountsRouter from "./accounts";
import messagesRouter from "./messages";
import inboxRouter from "./inbox";
import settingsRouter from "./settings";
import statsRouter from "./stats";
import viewRouter from "./view";
import { requireAuth } from "../middlewares/require-auth";

const router: IRouter = Router();

// The gate. Everything below this line except /healthz, /auth/*, and the
// signed /view/* links requires a valid session; see
// middlewares/require-auth.ts for the allow-list.
router.use(requireAuth);

router.use(healthRouter);
router.use(authRouter);
router.use(accountsRouter);
router.use(messagesRouter);
router.use(inboxRouter);
router.use(settingsRouter);
router.use(statsRouter);
router.use(viewRouter);

// Unmatched /api/* paths are API errors, so answer with JSON instead of falling
// through to the SPA-style HTML default.
router.use((req, res) => {
  res.status(404).json({
    error: "NotFound",
    message: `No route for ${req.method} ${req.baseUrl}${req.path}`,
  });
});

export default router;
