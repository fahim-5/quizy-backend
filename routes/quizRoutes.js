import express from "express";
import quizController from "../controllers/quizController.js";
import monitorController from "../controllers/monitorController.js";
import { protect, authorize, optionalAuth } from "../middleware/auth.js";

const router = express.Router();

router.get("/", quizController.getQuizzes);
router.get("/code/:code", quizController.getQuizByCode);
router.post("/", protect, authorize("teacher"), quizController.createQuiz);
router.get("/:id", quizController.getQuiz);
router.put("/:id", protect, authorize("teacher"), quizController.updateQuiz);
router.delete("/:id", protect, authorize("teacher"), quizController.deleteQuiz);

router.post(
  "/:id/undo",
  protect,
  authorize("teacher"),
  quizController.undoQuiz,
);

router.post(
  "/:id/duplicate",
  protect,
  authorize("teacher"),
  quizController.duplicateQuiz,
);

// Live monitor endpoints
router.get(
  "/:id/monitor",
  protect,
  authorize("teacher"),
  monitorController.getMonitor,
);
router.get(
  "/:id/monitor/export",
  protect,
  authorize("teacher"),
  monitorController.exportMonitorCsv,
);
router.post("/:id/monitor/join", optionalAuth, monitorController.joinSession);
router.post(
  "/:id/monitor/answer",
  optionalAuth,
  monitorController.submitAnswer,
);
router.post(
  "/:id/monitor/control",
  protect,
  authorize("teacher"),
  monitorController.control,
);

export default router;
