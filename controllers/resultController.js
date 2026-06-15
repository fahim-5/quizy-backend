import mongoose from "mongoose";
import Result from "../models/Result.js";
import Question from "../models/Question.js";
import Quiz from "../models/Quiz.js";
import PDFDocument from "pdfkit";
import stream from "stream";

// Create a draft result when a user starts a quiz. Records startedAt.
const startResult = async (req, res, next) => {
  try {
    const user = req.user && req.user.id ? req.user.id : undefined;
    const guestName = req.body.guestName || undefined;
    const { quiz } = req.body;
    // Enforce scheduled start time when present
    const quizDoc = await Quiz.findById(quiz);
    if (!quizDoc)
      return res
        .status(404)
        .json({ success: false, message: "Quiz not found" });
    // If a joinCode is set on the quiz, require it for non-owner/unauthenticated users
    const providedCode = (
      req.body.joinCode ||
      req.query.code ||
      req.headers["x-join-code"] ||
      ""
    )
      .toString()
      .trim();
    const isOwner = req.user && req.user.role === "teacher";
    // Treat reserved code '1234' as open (no code required)
    if (
      quizDoc.joinCode &&
      String(quizDoc.joinCode).trim() !== "" &&
      String(quizDoc.joinCode).trim() !== "1234" &&
      !isOwner
    ) {
      if (!providedCode || providedCode !== String(quizDoc.joinCode).trim()) {
        return res
          .status(403)
          .json({ success: false, message: "Join code required" });
      }
    }
    const now = new Date();
    if (quizDoc.startFrom && now < new Date(quizDoc.startFrom)) {
      // allow teachers to create drafts early
      if (!(req.user && req.user.role === "teacher")) {
        return res
          .status(403)
          .json({ success: false, message: "Quiz not open yet" });
      }
    }

    const draftPayload = {
      quiz,
      startedAt: new Date(),
      status: "in-progress",
    };
    if (user) draftPayload.user = user;
    else if (guestName) draftPayload.guestName = guestName;

    // Prevent authenticated users from starting the same quiz twice
    if (user) {
      // If there's a completed attempt, return it to the client
      const existingCompleted = await Result.findOne({
        quiz,
        user,
        status: "completed",
      }).sort({ takenAt: -1 });
      if (existingCompleted) {
        // 409 indicates conflict: quiz already taken
        try {
          await existingCompleted.populate(
            "answers.question",
            "text options correctIndex points",
          );
        } catch (e) {}
        return res.status(409).json({
          success: false,
          message: "Quiz already taken",
          result: existingCompleted,
        });
      }

      // If there's an in-progress draft for the user, return that to allow resume
      const existingDraft = await Result.findOne({
        quiz,
        user,
        status: "in-progress",
      }).sort({ createdAt: -1 });
      if (existingDraft) {
        return res.status(200).json({ success: true, result: existingDraft });
      }
    }

    const draft = await Result.create(draftPayload);
    res.status(201).json({ success: true, result: draft });
  } catch (err) {
    next(err);
  }
};

// Submit result: server-side scoring for objective questions
// Accepts optional `resultId` to validate startedAt/timeLimit.
const submitResult = async (req, res, next) => {
  try {
    // Expect body: { quiz: quizId, answers: [{ question: questionId, answerIndex: Number }], resultId, guestName }
    const user = req.user && req.user.id ? req.user.id : undefined;
    const guestName = req.body.guestName || undefined;
    const { quiz, answers = [], resultId } = req.body;

    // Sanitize answers
    const sanitizedAnswers = Array.isArray(answers)
      ? answers.map((a) => ({
          question: String(a.question),
          answerIndex: Number(a.answerIndex),
        }))
      : [];

    // If draft provided, load and validate
    let draft = null;
    let quizId = quiz;
    if (resultId) {
      draft = await Result.findById(resultId);
      if (!draft)
        return res
          .status(404)
          .json({ success: false, message: "Draft result not found" });
      if (draft.status === "completed")
        return res
          .status(400)
          .json({ success: false, message: "Result already submitted" });
      quizId = draft.quiz.toString();
      // if draft has guestName, prefer it
      if (draft.guestName) {
        // keep guestName for submission
      }

      // enforce time limit
      const quizDoc = await Quiz.findById(quizId);
      const timeLimitSec = (quizDoc && quizDoc.timeLimit) || 0;
      if (timeLimitSec > 0 && draft.startedAt) {
        const elapsed = Date.now() - new Date(draft.startedAt).getTime();
        if (elapsed > timeLimitSec * 1000) {
          // mark draft completed to avoid retries
          await Result.findByIdAndUpdate(resultId, { status: "completed" });
          return res
            .status(400)
            .json({ success: false, message: "Time limit exceeded" });
        }
      }
    }

    // Fetch all quiz questions to compute total points and build map
    const quizQuestions = await Question.find({ quiz: quizId });
    const qMap = {};
    let totalPossible = 0;
    quizQuestions.forEach((q) => {
      const id = q._id.toString();
      qMap[id] = q;
      // total possible per question is q.points (legacy)
      totalPossible += q.points || 0;
    });

    // Compute score by checking correctIndex equality
    let score = 0;
    sanitizedAnswers.forEach((a) => {
      const q = qMap[a.question];
      if (!q) return; // ignore answers to questions not in this quiz
      const idx = a.answerIndex;
      if (
        Number.isFinite(idx) &&
        Number.isInteger(idx) &&
        Array.isArray(q.options) &&
        idx >= 0 &&
        idx < q.options.length
      ) {
        const correct =
          typeof q.correctIndex !== "undefined" ? Number(q.correctIndex) : null;
        if (correct !== null && idx === correct) {
          score += q.points || 0;
        }
      }
    });

    const endedAt = new Date();
    const durationSec =
      draft && draft.startedAt
        ? Math.round(
            (endedAt.getTime() - new Date(draft.startedAt).getTime()) / 1000,
          )
        : undefined;

    // Atomically update draft if present and still in-progress
    if (draft) {
      const updated = await Result.findOneAndUpdate(
        { _id: resultId, status: "in-progress" },
        {
          score,
          total: totalPossible,
          answers: sanitizedAnswers,
          status: "completed",
          endedAt,
          duration: durationSec,
          takenAt: endedAt,
        },
        { new: true, runValidators: true },
      );
      if (!updated)
        return res.status(409).json({
          success: false,
          message: "Result already submitted or updated",
        });
      // populate question details for review
      try {
        await updated.populate(
          "answers.question",
          "text options correctIndex points",
        );
      } catch (e) {
        // ignore populate errors
      }
      return res.status(200).json({ success: true, result: updated });
    }

    // No draft: create a completed result (guest or authenticated)
    // Prevent duplicate completed attempts when no draft is provided
    if (user) {
      const existingCompleted = await Result.findOne({
        quiz: quizId,
        user,
        status: "completed",
      }).sort({ takenAt: -1 });
      if (existingCompleted) {
        try {
          await existingCompleted.populate(
            "answers.question",
            "text options correctIndex points",
          );
        } catch (e) {}
        return res.status(409).json({
          success: false,
          message: "Quiz already taken",
          result: existingCompleted,
        });
      }
    }
    const createPayload = {
      quiz: quizId,
      score,
      total: totalPossible,
      answers: sanitizedAnswers,
      status: "completed",
      startedAt: undefined,
      endedAt,
      duration: durationSec,
      takenAt: endedAt,
    };
    if (user) createPayload.user = user;
    else if (guestName) createPayload.guestName = guestName;

    const created = await Result.create(createPayload);
    // populate question details for review
    try {
      await created.populate(
        "answers.question",
        "text options correctIndex points",
      );
    } catch (e) {
      // ignore populate errors
    }

    return res.status(201).json({ success: true, result: created });
  } catch (err) {
    next(err);
  }
};

const getResultsForUser = async (req, res, next) => {
  try {
    const results = await Result.find({ user: req.params.userId });
    res.json({ success: true, results });
  } catch (err) {
    next(err);
  }
};

// Return results for the currently authenticated user
const getMyResults = async (req, res, next) => {
  try {
    const userId = req.user && req.user.id ? req.user.id : null;
    if (!userId)
      return res
        .status(401)
        .json({ success: false, message: "Not authenticated" });
    const results = await Result.find({ user: userId })
      .populate("quiz", "title timeLimit")
      .sort({ takenAt: -1, createdAt: -1 });
    res.json({ success: true, results });
  } catch (err) {
    next(err);
  }
};

// Return a simple summary for the current user: attempts, average %, best score, last taken
const getMySummary = async (req, res, next) => {
  try {
    const userId = req.user && req.user.id ? req.user.id : null;
    if (!userId)
      return res
        .status(401)
        .json({ success: false, message: "Not authenticated" });

    const results = await Result.find({
      user: userId,
      status: "completed",
    }).sort({ takenAt: -1 });
    const attempts = results.length;
    const totalPoints = results.reduce((acc, r) => acc + (r.total || 0), 0);
    const totalScore = results.reduce((acc, r) => acc + (r.score || 0), 0);
    const bestScore = results.reduce(
      (acc, r) => Math.max(acc, r.score || 0),
      0,
    );
    const lastTaken = results.length ? results[0].takenAt : null;
    const avgPercent =
      totalPoints > 0
        ? Math.round((totalScore / totalPoints) * 100 * 100) / 100
        : 0; // two decimals

    res.json({
      success: true,
      summary: {
        attempts,
        totalScore,
        totalPoints,
        avgPercent,
        bestScore,
        lastTaken,
      },
    });
  } catch (err) {
    next(err);
  }
};

export default {
  startResult,
  submitResult,
  getResultsForUser,
  getMyResults,
  getMySummary,
};

// Return a single result by id (populated). Ownership or teacher required.
const getResultById = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id)
      return res
        .status(400)
        .json({ success: false, message: "Result id required" });
    const result = await Result.findById(id)
      .populate("answers.question", "text options correctIndex points")
      .populate("quiz", "title timeLimit");
    if (!result)
      return res
        .status(404)
        .json({ success: false, message: "Result not found" });

    const userId = req.user && req.user.id ? req.user.id : null;
    // If result belongs to a user, ensure requester is owner or a teacher
    if (result.user && userId && result.user.toString() !== userId) {
      // allow teachers
      if (!(req.user && req.user.role === "teacher")) {
        return res.status(403).json({
          success: false,
          message: "Not authorized to view this result",
        });
      }
    }

    res.json({ success: true, result });
  } catch (err) {
    next(err);
  }
};

export { getResultById };

// Teacher analytics
// Leaderboard for a quiz: top N users by best score
const leaderboardForQuiz = async (req, res, next) => {
  try {
    const quizId = req.params.quizId;
    const limit = Math.min(Number(req.query.limit) || 10, 100);
    const skip = Math.max(Number(req.query.skip) || 0, 0);
    const { startDate, endDate } = req.query;

    // build date filter if provided
    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);

    const match = {
      quiz: new mongoose.Types.ObjectId(quizId),
      status: "completed",
    };
    if (startDate || endDate) match.takenAt = dateFilter;

    const agg = await Result.aggregate([
      { $match: match },
      { $sort: { score: -1 } },
      {
        $group: {
          _id: "$user",
          bestScore: { $max: "$score" },
          total: { $max: "$total" },
          lastTaken: { $max: "$takenAt" },
        },
      },
      { $sort: { bestScore: -1 } },
      { $skip: skip },
      { $limit: limit },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          user: {
            _id: "$user._id",
            name: "$user.name",
            identifier: "$user.identifier",
          },
          bestScore: 1,
          total: 1,
          lastTaken: 1,
        },
      },
    ]);

    res.json({ success: true, leaderboard: agg });
  } catch (err) {
    next(err);
  }
};

// Quiz-level stats: attempts, avg score, avg percent, top score
const quizStats = async (req, res, next) => {
  try {
    const quizId = req.params.quizId;
    const { startDate, endDate } = req.query;

    const match = {
      quiz: new mongoose.Types.ObjectId(quizId),
      status: "completed",
    };
    if (startDate || endDate) {
      const dateFilter = {};
      if (startDate) dateFilter.$gte = new Date(startDate);
      if (endDate) dateFilter.$lte = new Date(endDate);
      match.takenAt = dateFilter;
    }

    const agg = await Result.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          attempts: { $sum: 1 },
          totalScore: { $sum: "$score" },
          totalPossible: { $sum: "$total" },
          avgScore: { $avg: "$score" },
          topScore: { $max: "$score" },
          minScore: { $min: "$score" },
        },
      },
    ]);

    const data = agg[0] || {
      attempts: 0,
      totalScore: 0,
      totalPossible: 0,
      avgScore: 0,
      topScore: 0,
      minScore: 0,
    };
    const avgPercent =
      data.totalPossible > 0
        ? Math.round((data.totalScore / data.totalPossible) * 100 * 100) / 100
        : 0;
    res.json({
      success: true,
      stats: {
        attempts: data.attempts,
        avgScore: data.avgScore,
        avgPercent,
        topScore: data.topScore,
        minScore: data.minScore,
      },
    });
  } catch (err) {
    next(err);
  }
};

// Participation summary across quizzes: attempts per quiz and avg percent
const participationSummary = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const match = { status: "completed" };
    if (startDate || endDate) {
      const dateFilter = {};
      if (startDate) dateFilter.$gte = new Date(startDate);
      if (endDate) dateFilter.$lte = new Date(endDate);
      match.takenAt = dateFilter;
    }

    const agg = await Result.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$quiz",
          attempts: { $sum: 1 },
          totalScore: { $sum: "$score" },
          totalPossible: { $sum: "$total" },
        },
      },
      {
        $lookup: {
          from: "quizzes",
          localField: "_id",
          foreignField: "_id",
          as: "quiz",
        },
      },
      { $unwind: { path: "$quiz", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          quizId: "$_id",
          title: "$quiz.title",
          attempts: 1,
          avgPercent: {
            $cond: [
              { $gt: ["$totalPossible", 0] },
              {
                $multiply: [
                  { $divide: ["$totalScore", "$totalPossible"] },
                  100,
                ],
              },
              0,
            ],
          },
        },
      },
      { $sort: { attempts: -1 } },
    ]);

    res.json({ success: true, participation: agg });
  } catch (err) {
    next(err);
  }
};

// Export leaderboard CSV for a quiz (teacher)
const exportLeaderboardCSV = async (req, res, next) => {
  try {
    const quizId = req.params.quizId;
    const { startDate, endDate } = req.query;
    const match = {
      quiz: new mongoose.Types.ObjectId(quizId),
      status: "completed",
    };
    if (startDate || endDate) {
      const dateFilter = {};
      if (startDate) dateFilter.$gte = new Date(startDate);
      if (endDate) dateFilter.$lte = new Date(endDate);
      match.takenAt = dateFilter;
    }

    const agg = await Result.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$user",
          bestScore: { $max: "$score" },
          total: { $max: "$total" },
          lastTaken: { $max: "$takenAt" },
          attempts: { $sum: 1 },
        },
      },
      { $sort: { bestScore: -1 } },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          name: "$user.name",
          identifier: "$user.identifier",
          bestScore: 1,
          total: 1,
          attempts: 1,
          lastTaken: 1,
        },
      },
    ]);

    // Build CSV
    const header = [
      "Name",
      "Identifier",
      "BestScore",
      "Total",
      "Attempts",
      "LastTaken",
    ].join(",");
    const lines = agg.map((r) =>
      [
        (r.name || "").replace(/"/g, '""'),
        r.identifier || "",
        r.bestScore || 0,
        r.total || 0,
        r.attempts || 0,
        r.lastTaken ? new Date(r.lastTaken).toISOString() : "",
      ].join(","),
    );
    const csv = [header, ...lines].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=leaderboard_${quizId}.csv`,
    );
    res.send(csv);
  } catch (err) {
    next(err);
  }
};

// Export functions (named exports) — include core and teacher helpers
export {
  startResult,
  submitResult,
  getResultsForUser,
  getMyResults,
  getMySummary,
  leaderboardForQuiz,
  quizStats,
  participationSummary,
  exportLeaderboardCSV,
};

// Additional reports: question analysis and PDF export
const questionAnalysis = async (req, res, next) => {
  try {
    const quizId = req.params.quizId;
    const results = await Result.find({
      quiz: quizId,
      status: "completed",
    }).lean();
    const questions = await Question.find({ quiz: quizId }).lean();

    const qMap = {};
    questions.forEach((q) => {
      qMap[q._id.toString()] = { question: q, total: 0, correct: 0 };
    });

    for (const r of results) {
      for (const a of r.answers || []) {
        const qid = String(a.question);
        if (!qMap[qid]) continue;
        qMap[qid].total += 1;
        // determine correctness
        const q = qMap[qid].question;
        let correct = false;
        if (
          (q.type === "mcq" || q.type === "tf") &&
          typeof a.answerIndex !== "undefined"
        ) {
          correct = Number(a.answerIndex) === Number(q.correctIndex);
        } else if (q.type === "short" && q.answerText) {
          correct =
            String(a.answer || "")
              .trim()
              .toLowerCase() ===
            String(q.answerText || "")
              .trim()
              .toLowerCase();
        }
        if (correct) qMap[qid].correct += 1;
      }
    }

    const analysis = Object.keys(qMap).map((qid) => {
      const item = qMap[qid];
      const percent = item.total
        ? Math.round((item.correct / item.total) * 100)
        : 0;
      let difficulty = "medium";
      if (percent >= 80) difficulty = "easy";
      else if (percent < 50) difficulty = "hard";
      return {
        questionId: qid,
        text: item.question.text,
        total: item.total,
        correct: item.correct,
        percent,
        difficulty,
      };
    });

    // overall class average (avg percent across results)
    const totalPossible = results.reduce((acc, r) => acc + (r.total || 0), 0);
    const totalScore = results.reduce((acc, r) => acc + (r.score || 0), 0);
    const classAvgPercent = totalPossible
      ? Math.round((totalScore / totalPossible) * 100 * 100) / 100
      : 0;

    // top 5 performers (by bestScore)
    const leaderboard = await leaderboardForQuizInternal(quizId, 5);

    res.json({
      success: true,
      classAvgPercent,
      analysis,
      topPerformers: leaderboard,
    });
  } catch (err) {
    next(err);
  }
};

// helper to return top performers without Express req/res
const leaderboardForQuizInternal = async (quizId, limit = 5) => {
  const agg = await Result.aggregate([
    {
      $match: {
        quiz: new mongoose.Types.ObjectId(quizId),
        status: "completed",
      },
    },
    {
      $group: {
        _id: "$user",
        bestScore: { $max: "$score" },
        total: { $max: "$total" },
        lastTaken: { $max: "$takenAt" },
      },
    },
    { $sort: { bestScore: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "_id",
        as: "user",
      },
    },
    { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        name: "$user.name",
        identifier: "$user.identifier",
        bestScore: 1,
        total: 1,
        lastTaken: 1,
      },
    },
  ]);
  return agg;
};

const exportReportPDF = async (req, res, next) => {
  try {
    const quizId = req.params.quizId;
    const analysisRes = await (async () => {
      const results = await Result.find({
        quiz: quizId,
        status: "completed",
      }).lean();
      const questions = await Question.find({ quiz: quizId }).lean();
      const qMap = {};
      questions.forEach((q) => {
        qMap[q._id.toString()] = { question: q, total: 0, correct: 0 };
      });
      for (const r of results) {
        for (const a of r.answers || []) {
          const qid = String(a.question);
          if (!qMap[qid]) continue;
          qMap[qid].total += 1;
          const q = qMap[qid].question;
          let correct = false;
          if (
            (q.type === "mcq" || q.type === "tf") &&
            typeof a.answerIndex !== "undefined"
          ) {
            correct = Number(a.answerIndex) === Number(q.correctIndex);
          } else if (q.type === "short" && q.answerText) {
            correct =
              String(a.answer || "")
                .trim()
                .toLowerCase() ===
              String(q.answerText || "")
                .trim()
                .toLowerCase();
          }
          if (correct) qMap[qid].correct += 1;
        }
      }
      const analysis = Object.keys(qMap).map((qid) => {
        const item = qMap[qid];
        const percent = item.total
          ? Math.round((item.correct / item.total) * 100)
          : 0;
        return {
          questionId: qid,
          text: item.question.text,
          total: item.total,
          correct: item.correct,
          percent,
        };
      });
      const totalPossible = results.reduce((acc, r) => acc + (r.total || 0), 0);
      const totalScore = results.reduce((acc, r) => acc + (r.score || 0), 0);
      const classAvgPercent = totalPossible
        ? Math.round((totalScore / totalPossible) * 100 * 100) / 100
        : 0;
      return { analysis, classAvgPercent };
    })();

    // build PDF
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const filename = `report_${quizId}.pdf`;
    res.setHeader("Content-disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-type", "application/pdf");

    doc.fontSize(20).text(`Quiz Report`, { align: "center" });
    doc.moveDown();
    doc.fontSize(12).text(`Class average: ${analysisRes.classAvgPercent}%`);
    doc.moveDown();
    doc.fontSize(14).text("Question Analysis:");
    doc.moveDown(0.5);
    analysisRes.analysis.forEach((q, idx) => {
      doc.fontSize(12).text(`${idx + 1}. ${q.text}`);
      doc
        .fontSize(10)
        .text(
          `   Attempts: ${q.total}  Correct: ${q.correct}  %Correct: ${q.percent}%`,
        );
      doc.moveDown(0.3);
    });

    doc.end();
    const passthrough = new stream.PassThrough();
    doc.pipe(passthrough);
    passthrough.pipe(res);
  } catch (err) {
    next(err);
  }
};

// expose new functions
export { questionAnalysis, exportReportPDF };

// Update a draft result's answers (autosave). Requires authentication and ownership.
const updateDraft = async (req, res, next) => {
  try {
    const userId = req.user && req.user.id ? req.user.id : null;
    const resultId = req.params.id;
    const { answers = [] } = req.body;

    if (!resultId)
      return res
        .status(400)
        .json({ success: false, message: "Result id required" });

    const draft = await Result.findById(resultId);
    if (!draft)
      return res
        .status(404)
        .json({ success: false, message: "Draft not found" });
    if (draft.status !== "in-progress")
      return res
        .status(400)
        .json({ success: false, message: "Cannot update a completed result" });

    // Ownership check: if draft is linked to a user, require same user
    if (draft.user && userId && draft.user.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to update this draft",
      });
    }

    // sanitize answers
    const sanitized = Array.isArray(answers)
      ? answers.map((a) => ({
          question: String(a.question),
          answerIndex: Number(a.answerIndex),
        }))
      : [];

    draft.answers = sanitized;
    await draft.save();

    return res.json({ success: true, result: draft });
  } catch (err) {
    next(err);
  }
};

export { updateDraft };

const getStudentReport = async (req, res, next) => {
  try {
    const { quizId, studentId } = req.params;
    // studentId is expected to be ObjectId of User
    const query = { quiz: quizId, status: "completed" };
    // if studentId looks like an object id, filter by user field
    if (studentId && mongoose.Types.ObjectId.isValid(studentId)) {
      query.user = new mongoose.Types.ObjectId(studentId);
    } else {
      // otherwise treat as guestName
      query.guestName = studentId;
    }

    const results = await Result.find(query)
      .populate("answers.question", "text options correctIndex points")
      .sort({ takenAt: -1 })
      .lean();
    res.json({ success: true, results });
  } catch (err) {
    next(err);
  }
};

export { getStudentReport };
