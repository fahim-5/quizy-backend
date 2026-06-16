import LiveParticipant from "../models/LiveParticipant.js";
import MonitorSession from "../models/MonitorSession.js";
import Question from "../models/Question.js";
import Quiz from "../models/Quiz.js";
import { getIo } from "../utils/socket.js";

const joinSession = async (req, res, next) => {
  try {
    const quizId = req.params.id;
    const name = req.body.name || (req.user && req.user.name) || "Guest";

    // Upsert participant by user id if available, otherwise create new guest participant
    let participant;
    if (req.user) {
      participant = await LiveParticipant.findOne({
        quiz: quizId,
        user: req.user._id,
      });
      if (!participant) {
        participant = await LiveParticipant.create({
          quiz: quizId,
          user: req.user._id,
          name,
        });
      } else {
        participant.name = name;
        participant.lastActive = new Date();
        participant.status = "joined";
        await participant.save();
      }
    } else {
      participant = await LiveParticipant.create({ quiz: quizId, name });
    }

    res.json({ success: true, participant });
    // emit update to room
    const io = getIo();
    if (io) io.to(`quiz-${quizId}`).emit("participant:joined", { participant });
  } catch (err) {
    next(err);
  }
};

const submitAnswer = async (req, res, next) => {
  try {
    const quizId = req.params.id;
    const { participantId, questionId, answer } = req.body;
    if (!participantId || !questionId)
      return res
        .status(400)
        .json({ message: "participantId and questionId required" });

    const participant = await LiveParticipant.findById(participantId);
    if (!participant)
      return res.status(404).json({ message: "Participant not found" });

    const question = await Question.findById(questionId);
    if (!question)
      return res.status(404).json({ message: "Question not found" });

    let correct = false;
    if (question.type === "mcq" || question.type === "tf") {
      // answer may be index or string
      const idx = Number(answer);
      correct = Number.isInteger(idx) && idx === question.correctIndex;
    } else if (question.type === "short") {
      if (question.answerText && typeof answer === "string") {
        correct =
          question.answerText.trim().toLowerCase() ===
          answer.trim().toLowerCase();
      }
    }

    const pointsAwarded = correct ? question.points || 1 : 0;

    participant.answers.push({
      question: questionId,
      answer: String(answer),
      correct,
      pointsAwarded,
      submittedAt: new Date(),
    });
    participant.lastActive = new Date();
    participant.status = "done";
    await participant.save();

    // emit answer update
    const io = getIo();
    if (io)
      io.to(`quiz-${quizId}`).emit("answer:submitted", {
        participantId: participant._id,
        questionId,
        answer,
        correct,
        pointsAwarded,
      });

    res.json({ success: true, participant });
  } catch (err) {
    next(err);
  }
};

const control = async (req, res, next) => {
  try {
    const quizId = req.params.id;
    const { action, message } = req.body;
    let session = await MonitorSession.findOne({ quiz: quizId });
    if (!session) {
      session = await MonitorSession.create({ quiz: quizId });
    }

    if (action === "pause") session.isPaused = true;
    else if (action === "resume") session.isPaused = false;
    else if (action === "end") session.isEnded = true;
    else if (action === "announce" && message)
      session.announcements.push({ message });

    session.updatedAt = new Date();
    await session.save();

    // emit control update
    const io = getIo();
    if (io)
      io.to(`quiz-${quizId}`).emit("monitor:control", {
        action,
        message,
        session,
      });

    res.json({ success: true, session });
  } catch (err) {
    next(err);
  }
};

const getMonitor = async (req, res, next) => {
  try {
    const quizId = req.params.id;
    const quiz = await Quiz.findById(quizId);
    if (!quiz) return res.status(404).json({ message: "Quiz not found" });

    const session = await MonitorSession.findOne({ quiz: quizId });

    // populate user info for participants when available
    const participants = await LiveParticipant.find({ quiz: quizId })
      .sort({ joinedAt: 1 })
      .populate("user", "name email")
      .lean();

    // Aggregate per-question stats
    const statsMap = {};
    for (const p of participants) {
      for (const a of p.answers || []) {
        const qid = String(a.question);
        statsMap[qid] = statsMap[qid] || {
          total: 0,
          correct: 0,
          wrong: 0,
          perAnswers: [],
        };
        statsMap[qid].total += 1;
        if (a.correct) statsMap[qid].correct += 1;
        else statsMap[qid].wrong += 1;
        statsMap[qid].perAnswers.push({
          participant: p._id,
          answer: a.answer,
          correct: a.correct,
        });
      }
    }

    // Populate question info (for stats) and compute total available points
    const questionIds = Object.keys(statsMap);
    const answeredQuestions = await Question.find({
      _id: { $in: questionIds },
    }).lean();
    const stats = answeredQuestions.map((q) => {
      const s = statsMap[String(q._id)] || {
        total: 0,
        correct: 0,
        wrong: 0,
        perAnswers: [],
      };
      const percentCorrect = s.total
        ? Math.round((s.correct / s.total) * 100)
        : 0;
      return {
        question: q,
        total: s.total,
        correct: s.correct,
        wrong: s.wrong,
        percentCorrect,
        perAnswers: s.perAnswers,
      };
    });

    // Compute total points for the quiz (all questions)
    const allQuestions = await Question.find({ quiz: quizId }).lean();
    const quizTotalPoints = (allQuestions || []).reduce(
      (acc, q) => acc + (q.points || 0),
      0,
    );

    // Compute per-participant total points and percent
    const participantsWithScores = (participants || []).map((p) => {
      const totalPoints = (p.answers || []).reduce(
        (acc, a) => acc + (a.pointsAwarded || 0),
        0,
      );
      const percent = quizTotalPoints
        ? Math.round((totalPoints / quizTotalPoints) * 100)
        : null;
      return { ...p, totalPoints, percent };
    });

    // Top performers (top 5)
    const topPerformers = (participantsWithScores || [])
      .slice()
      .sort((a, b) => (b.totalPoints || 0) - (a.totalPoints || 0))
      .slice(0, 5)
      .map((p) => ({
        _id: p._id,
        name: p.name || (p.user && p.user.name) || "Guest",
        email: p.user && p.user.email ? p.user.email : undefined,
        totalPoints: p.totalPoints || 0,
        percent: p.percent,
      }));

    res.json({
      success: true,
      quiz,
      session: session || null,
      participants: participantsWithScores,
      stats,
      quizTotalPoints,
      topPerformers,
    });
  } catch (err) {
    next(err);
  }
};
// Export CSV of participants and scores
const exportMonitorCsv = async (req, res, next) => {
  try {
    const quizId = req.params.id;
    const quiz = await Quiz.findById(quizId);
    if (!quiz) return res.status(404).json({ message: "Quiz not found" });

    const participants = await LiveParticipant.find({ quiz: quizId })
      .sort({ joinedAt: 1 })
      .populate("user", "name email")
      .lean();

    const allQuestions = await Question.find({ quiz: quizId }).lean();
    const quizTotalPoints = (allQuestions || []).reduce(
      (acc, q) => acc + (q.points || 0),
      0,
    );

    // Build CSV rows
    const rows = [];
    rows.push([
      "Participant",
      "Email",
      "TotalPoints",
      "Percent",
      "AnswersCount",
      "JoinedAt",
    ]);

    for (const p of participants) {
      const totalPoints = (p.answers || []).reduce(
        (acc, a) => acc + (a.pointsAwarded || 0),
        0,
      );
      const percent = quizTotalPoints
        ? Math.round((totalPoints / quizTotalPoints) * 100)
        : "";
      rows.push([
        p.name || (p.user && p.user.name) || "Guest",
        (p.user && p.user.email) || "",
        totalPoints,
        percent,
        (p.answers && p.answers.length) || 0,
        p.joinedAt ? new Date(p.joinedAt).toISOString() : "",
      ]);
    }

    const csv = rows
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");

    res.setHeader("Content-Type", "text/csv;charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${(quiz.title || "quiz").replace(/[^a-z0-9._-]/gi, "_")}-results.csv"`,
    );
    res.send(csv);
  } catch (err) {
    next(err);
  }
};

export default {
  joinSession,
  submitAnswer,
  control,
  getMonitor,
  exportMonitorCsv,
};
