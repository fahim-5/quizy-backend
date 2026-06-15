import Quiz from "../models/Quiz.js";
import Subject from "../models/Subject.js";
import User from "../models/User.js";
import Question from "../models/Question.js";

const createQuiz = async (req, res, next) => {
  try {
    // if a specific subject id is provided, return quizzes for that subject
    if (typeof req.query.subject === "string" && req.query.subject.trim()) {
      const subjId = String(req.query.subject).trim();
      // By default exclude soft-deleted quizzes; allow including them via includeDeleted=true
      const filter = { subject: subjId, isActive: true };
      if (req.query.all === "true") {
        if (req.query.includeDeleted === "true") {
          // caller requested deleted quizzes included
          delete filter.isActive;
        }
        const quizzes = await Quiz.find(filter)
          .limit(500)
          .populate("createdBy", "name identifier");
        return res.json({ success: true, quizzes });
      }
      // default: only active & visible quizzes for this subject
      const now = new Date();
      const quizzes = await Quiz.find({
        subject: subjId,
        isActive: true,
        $or: [
          { visibleFrom: { $exists: false } },
          { visibleFrom: null },
          { visibleFrom: { $lte: now } },
        ],
      })
        .limit(200)
        .populate("createdBy", "name identifier");
      return res.json({ success: true, quizzes });
    }
    const {
      title,
      description,
      subject,
      timeLimit,
      rules,
      visibleFrom,
      startFrom,
      attemptsAllowed,
      shuffleQuestions,
      showAnswersAfterSubmission,
      access,
      status,
      joinCode,
    } = req.body;

    if (!title || typeof title !== "string" || title.trim() === "") {
      return res
        .status(400)
        .json({ success: false, message: "Title is required" });
    }

    const payload = {
      // subject must be provided and valid
      subject: subject,
      title: title.trim(),
      description: description ? String(description).trim() : "",
      timeLimit: Number(timeLimit) || 0,
      rules: rules ? String(rules).trim() : "",
      visibleFrom: visibleFrom ? new Date(visibleFrom) : undefined,
      startFrom: startFrom ? new Date(startFrom) : undefined,
      attemptsAllowed: attemptsAllowed || "single",
      shuffleQuestions: !!shuffleQuestions,
      showAnswersAfterSubmission: !!showAnswersAfterSubmission,
      access: access || "public",
      status: status || "draft",
      allowedList: Array.isArray(req.body.allowedList)
        ? req.body.allowedList
        : typeof req.body.allowedList === "string"
          ? req.body.allowedList
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
    };

    // verify subject exists
    if (!payload.subject) {
      return res
        .status(400)
        .json({ success: false, message: "Subject id is required" });
    }
    const subjDoc = await Subject.findById(String(payload.subject));
    if (!subjDoc) {
      return res
        .status(400)
        .json({ success: false, message: "Subject not found" });
    }

    // attach creator if available
    if (req.user && req.user.id) {
      payload.createdBy = req.user.id;
    }

    // generate a join code if not provided
    if (!joinCode) {
      // If subject is open (no enrollKey), use a reserved open code '1234' so
      // students can attend without entering a code.
      if (!subjDoc.enrollKey || String(subjDoc.enrollKey).trim() === "") {
        payload.joinCode = "1234";
      } else {
        const genCode = () =>
          Math.floor(100000 + Math.random() * 900000).toString();
        let code = genCode();
        // avoid unlikely collisions by checking existing codes a few times
        for (let i = 0; i < 5; i++) {
          const exists = await Quiz.findOne({ joinCode: code });
          if (!exists) break;
          code = genCode();
        }
        payload.joinCode = code;
      }
    } else {
      payload.joinCode = String(joinCode).trim();
    }

    const quiz = await Quiz.create(payload);
    res.status(201).json({ success: true, quiz });
  } catch (err) {
    next(err);
  }
};

const getQuizByCode = async (req, res, next) => {
  try {
    const code = String(req.params.code || "").trim();
    if (!code)
      return res.status(400).json({ success: false, message: "Code required" });
    const quiz = await Quiz.findOne({ joinCode: code });
    if (!quiz)
      return res
        .status(404)
        .json({ success: false, message: "Quiz not found" });
    res.json({ success: true, quiz });
  } catch (err) {
    next(err);
  }
};

const getQuizzes = async (req, res, next) => {
  try {
    // By default return active quizzes only and only those visible now.
    // Teachers/admins can request all via ?all=true.
    // Support server-side search via ?search=... which matches quiz title or subject code.
    const now = new Date();
    const search =
      typeof req.query.search === "string" && req.query.search.trim()
        ? String(req.query.search).trim()
        : null;

    // If a specific subject id is provided, return quizzes for that subject.
    if (typeof req.query.subject === "string" && req.query.subject.trim()) {
      const subjId = String(req.query.subject).trim();
      // If caller wants all quizzes for this subject (e.g., teacher viewing their course)
      if (req.query.all === "true") {
        const filter = { subject: subjId };
        if (req.query.mine === "true" && req.user) {
          filter.createdBy = req.user.id;
        }
        const quizzes = await Quiz.find(filter)
          .limit(500)
          .populate("createdBy", "name identifier");
        return res.json({ success: true, quizzes });
      }

      // Default: only active & visible quizzes for this subject
      const match = {
        subject: subjId,
        isActive: true,
        $or: [
          { visibleFrom: { $exists: false } },
          { visibleFrom: null },
          { visibleFrom: { $lte: now } },
        ],
      };
      if (req.query.mine === "true" && req.user) {
        match.createdBy = req.user.id;
      }
      const quizzes = await Quiz.find(match)
        .limit(200)
        .populate("createdBy", "name identifier");
      return res.json({ success: true, quizzes });
    }
    if (req.query.all === "true") {
      // By default exclude soft-deleted quizzes; allow including them via includeDeleted=true
      const base =
        req.query.includeDeleted === "true" ? {} : { isActive: true };
      if (search) {
        // search across title or subject code
        const regex = new RegExp(
          search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "i",
        );
        // find matching subjects by code
        const subjDocs = await Subject.find({ code: { $regex: regex } }).select(
          "_id",
        );
        const subjIds = subjDocs.map((s) => s._id);
        // allow searching by teacher name as well
        const userDocs = await User.find({ name: { $regex: regex } }).select(
          "_id",
        );
        const userIds = userDocs.map((u) => u._id);
        const base = {
          $or: [
            { title: { $regex: regex } },
            { subject: { $in: subjIds } },
            { createdBy: { $in: userIds } },
          ],
        };
        if (req.query.mine === "true" && req.user) {
          base.createdBy = req.user.id;
        }
        const quizzes = await Quiz.find(base)
          .limit(500)
          .populate("createdBy", "name identifier");
        return res.json({ success: true, quizzes });
      }
      if (req.query.mine === "true" && req.user) {
        base.createdBy = req.user.id;
      }
      const quizzes = await Quiz.find(base)
        .limit(500)
        .populate("createdBy", "name identifier");
      return res.json({ success: true, quizzes });
    }

    // If caller requests assigned quizzes for the logged-in user
    if (req.query.assigned === "true") {
      // require authentication for assigned filtering
      const user = req.user || null;
      if (!user)
        return res
          .status(401)
          .json({ success: false, message: "Not authenticated" });

      // Match active quizzes visible now
      const baseMatch = {
        isActive: true,
        $or: [
          { visibleFrom: { $exists: false } },
          { visibleFrom: null },
          { visibleFrom: { $lte: now } },
        ],
      };

      // For students: return quizzes that are public OR private quizzes where allowedList contains the user's identifier or email
      const candidate = await Quiz.find({
        ...baseMatch,
        $or: [
          { access: "public" },
          {
            access: "private",
            allowedList: { $in: [user.identifier, user.email] },
          },
        ],
      }).limit(200);
      return res.json({ success: true, quizzes: candidate });
    }

    // If a search query was provided, search active/visible quizzes by title or subject code
    if (search) {
      const regex = new RegExp(
        search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      );
      const subjDocs = await Subject.find({ code: { $regex: regex } }).select(
        "_id",
      );
      const subjIds = subjDocs.map((s) => s._id);
      // support searching by teacher name
      const userDocs = await User.find({ name: { $regex: regex } }).select(
        "_id",
      );
      const userIds = userDocs.map((u) => u._id);
      const match = {
        isActive: true,
        $or: [
          { visibleFrom: { $exists: false } },
          { visibleFrom: null },
          { visibleFrom: { $lte: now } },
        ],
      };
      if (req.query.mine === "true" && req.user) {
        match.createdBy = req.user.id;
      }
      const quizzes = await Quiz.find({
        ...match,
        $or: [
          { title: { $regex: regex } },
          { subject: { $in: subjIds } },
          { createdBy: { $in: userIds } },
        ],
      })
        .limit(50)
        .populate("createdBy", "name identifier");
      return res.json({ success: true, quizzes });
    }

    // Default: Only return quizzes that are active and either have no visibleFrom or visibleFrom <= now
    const baseMatch = {
      isActive: true,
      $or: [
        { visibleFrom: { $exists: false } },
        { visibleFrom: null },
        { visibleFrom: { $lte: now } },
      ],
    };
    if (req.query.mine === "true" && req.user) {
      baseMatch.createdBy = req.user.id;
    }
    const quizzes = await Quiz.find(baseMatch)
      .limit(50)
      .populate("createdBy", "name identifier");
    res.json({ success: true, quizzes });
  } catch (err) {
    next(err);
  }
};

const getQuiz = async (req, res, next) => {
  try {
    const quiz = await Quiz.findById(req.params.id).populate(
      "createdBy",
      "name identifier",
    );
    if (!quiz) return res.status(404).json({ message: "Quiz not found" });
    // If a joinCode is set on the quiz, require it for non-owners
    const providedCode = (req.query.code || req.headers["x-join-code"] || "")
      .toString()
      .trim();
    const isOwner =
      req.user &&
      req.user.id &&
      String(quiz.createdBy?._id || quiz.createdBy) === String(req.user.id);
    // Treat the reserved code '1234' as an open quiz (no code required)
    if (
      quiz.joinCode &&
      String(quiz.joinCode).trim() !== "" &&
      String(quiz.joinCode).trim() !== "1234" &&
      !isOwner
    ) {
      if (!providedCode || providedCode !== String(quiz.joinCode).trim()) {
        return res
          .status(403)
          .json({ success: false, message: "Join code required" });
      }
    }
    res.json({ success: true, quiz });
  } catch (err) {
    next(err);
  }
};

const updateQuiz = async (req, res, next) => {
  try {
    const updates = req.body || {};
    const quiz = await Quiz.findById(req.params.id);
    if (!quiz) return res.status(404).json({ message: "Quiz not found" });
    // ownership check: only creator may update (teachers only)
    if (
      req.user &&
      req.user.id &&
      String(quiz.createdBy) !== String(req.user.id)
    ) {
      return res.status(403).json({ message: "Forbidden: not the owner" });
    }
    Object.assign(quiz, updates);
    await quiz.save();
    res.json({ success: true, quiz });
  } catch (err) {
    next(err);
  }
};

const deleteQuiz = async (req, res, next) => {
  try {
    // Soft-delete: mark inactive and record who deleted and when
    const quiz = await Quiz.findById(req.params.id);

    if (!quiz) return res.status(404).json({ message: "Quiz not found" });
    if (
      req.user &&
      req.user.id &&
      String(quiz.createdBy) !== String(req.user.id)
    ) {
      return res.status(403).json({ message: "Forbidden: not the owner" });
    }
    quiz.isActive = false;
    quiz.deletedAt = new Date();
    quiz.deletedBy = req.user ? req.user.id : undefined;
    await quiz.save();
    res.json({ success: true, message: "Soft-deleted", quizId: quiz._id });
  } catch (err) {
    next(err);
  }
};

const undoQuiz = async (req, res, next) => {
  try {
    const quiz = await Quiz.findById(req.params.id);
    if (!quiz) return res.status(404).json({ message: "Quiz not found" });
    if (
      req.user &&
      req.user.id &&
      String(quiz.createdBy) !== String(req.user.id)
    ) {
      return res.status(403).json({ message: "Forbidden: not the owner" });
    }
    if (quiz.isActive)
      return res.status(400).json({ message: "Quiz is already active" });
    quiz.isActive = true;
    quiz.deletedAt = undefined;
    quiz.deletedBy = undefined;
    await quiz.save();
    res.json({ success: true, message: "Restored", quizId: quiz._id });
  } catch (err) {
    next(err);
  }
};

const duplicateQuiz = async (req, res, next) => {
  try {
    const orig = await Quiz.findById(req.params.id);
    if (!orig) return res.status(404).json({ message: "Quiz not found" });
    // Only owner may duplicate (or allow creator to be set to duplicator)
    if (
      req.user &&
      req.user.id &&
      String(orig.createdBy) !== String(req.user.id)
    ) {
      return res.status(403).json({ message: "Forbidden: not the owner" });
    }

    // clone quiz fields
    const payload = {
      title: `${orig.title} (copy)`,
      subject: orig.subject,
      description: orig.description,
      timeLimit: orig.timeLimit,
      rules: orig.rules,
      visibleFrom: orig.visibleFrom,
      startFrom: orig.startFrom,
      attemptsAllowed: orig.attemptsAllowed,
      shuffleQuestions: orig.shuffleQuestions,
      showAnswersAfterSubmission: orig.showAnswersAfterSubmission,
      access: orig.access,
      status: "draft",
      allowedList: orig.allowedList || [],
    };

    // generate joinCode for the new quiz
    const genCode = () =>
      Math.floor(100000 + Math.random() * 900000).toString();
    let code = genCode();
    for (let i = 0; i < 5; i++) {
      const exists = await Quiz.findOne({ joinCode: code });
      if (!exists) break;
      code = genCode();
    }
    payload.joinCode = code;

    // set creator of duplicate to the requesting user when available
    if (req.user && req.user.id) payload.createdBy = req.user.id;
    const created = await Quiz.create(payload);

    // duplicate questions
    const questions = await Question.find({ quiz: orig._id });
    if (questions && questions.length > 0) {
      const copies = questions.map((q) => {
        const obj = q.toObject();
        delete obj._id;
        obj.quiz = created._id;
        return obj;
      });
      await Question.insertMany(copies);
    }

    res.status(201).json({ success: true, quiz: created });
  } catch (err) {
    next(err);
  }
};

export default {
  createQuiz,
  getQuizzes,
  getQuiz,
  updateQuiz,
  deleteQuiz,
  undoQuiz,
  getQuizByCode,
  duplicateQuiz,
};
