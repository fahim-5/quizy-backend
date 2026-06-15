import Subject from "../models/Subject.js";
import User from "../models/User.js";
import Quiz from "../models/Quiz.js";
import Question from "../models/Question.js";
import AppError from "../utils/appError.js";

const createSubject = async (req, res, next) => {
  try {
    const { name, code, enrollKey } = req.body;
    if (!name || !code)
      return res
        .status(400)
        .json({ success: false, message: "name and code required" });

    // ensure code uniqueness
    const exists = await Subject.findOne({ code: String(code).trim() });
    if (exists)
      return res
        .status(409)
        .json({ success: false, message: "Subject code already exists" });

    const payload = {
      name: String(name).trim(),
      code: String(code).trim(),
      enrollKey: enrollKey ? String(enrollKey).trim() : undefined,
      createdBy: req.user ? req.user._id : undefined,
    };

    const subject = await Subject.create(payload);
    res.status(201).json({ success: true, subject });
  } catch (err) {
    next(err);
  }
};

const getSubjects = async (req, res, next) => {
  try {
    const search =
      typeof req.query.search === "string" && req.query.search.trim()
        ? String(req.query.search).trim()
        : null;
    const mine = req.query.mine === "true" || req.query.mine === "1";
    const teacherId = req.query.teacherId || null;
    if (search) {
      const regex = new RegExp(
        search.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&"),
        "i",
      );
      // also allow searching by teacher name
      const userDocs = await User.find({ name: { $regex: regex } }).select(
        "_id",
      );
      const userIds = userDocs.map((u) => u._id);
      const subjects = await Subject.find({
        $or: [
          { code: { $regex: regex } },
          { name: { $regex: regex } },
          { createdBy: { $in: userIds } },
        ],
      })
        .limit(200)
        .sort({ createdAt: -1 })
        .populate("createdBy", "name identifier institution email");
      return res.json({ success: true, subjects });
    }

    // If requesting only the current teacher's subjects and an authenticated
    // user is present, filter by createdBy. Or, if a teacherId query param
    // is provided, filter by that id. Otherwise return all subjects.
    const query = {};
    if (teacherId) {
      // return subjects either created by the teacher or where the teacher
      // appears in common enrollment/member arrays
      query.$or = [
        { createdBy: teacherId },
        { participants: teacherId },
        { students: teacherId },
        { enrolled: teacherId },
        { enrolledUsers: teacherId },
        { members: teacherId },
        { users: teacherId },
      ];
    } else if (mine && req.user && req.user.role === "teacher") {
      query.createdBy = req.user._id;
    }

    let subjects = await Subject.find(query)
      .limit(200)
      .sort({ createdAt: -1 })
      .populate("createdBy", "name identifier institution email")
      .populate("enrolledUsers", "_id");

    // If a user is present (optional auth), annotate subjects with isEnrolled boolean
    if (req.user) {
      subjects = subjects.map((s) => {
        const obj = s.toObject ? s.toObject() : s;
        obj.isEnrolled = Array.isArray(obj.enrolledUsers)
          ? obj.enrolledUsers.some(
              (u) => String(u._id || u) === String(req.user._id),
            )
          : false;
        return obj;
      });
    }

    res.json({ success: true, subjects });
  } catch (err) {
    next(err);
  }
};

const getSubject = async (req, res, next) => {
  try {
    const subject = await Subject.findById(req.params.id)
      .populate("createdBy", "name identifier institution email")
      .populate("enrolledUsers", "_id name");
    if (!subject)
      return res.status(404).json({ success: false, message: "Not found" });

    // indicate whether the requesting user is enrolled
    const isEnrolled = req.user
      ? subject.enrolledUsers.some(
          (u) => String(u._id) === String(req.user._id),
        )
      : false;

    res.json({ success: true, subject, isEnrolled });
  } catch (err) {
    next(err);
  }
};

const enrollSubject = async (req, res, next) => {
  try {
    if (!req.user)
      return res
        .status(401)
        .json({ success: false, message: "Not authenticated" });
    const { id } = req.params;
    const { enrollKey } = req.body;
    const subject = await Subject.findById(id);
    if (!subject)
      return res
        .status(404)
        .json({ success: false, message: "Course not found" });

    // if already enrolled, return success
    if (
      subject.enrolledUsers &&
      subject.enrolledUsers.find((u) => String(u) === String(req.user._id))
    ) {
      return res.json({ success: true, message: "Already enrolled" });
    }

    // If course has no enrollKey, allow enrollment without a key
    if (subject.enrollKey && String(subject.enrollKey).trim() !== "") {
      if (
        !enrollKey ||
        String(enrollKey).trim() !== String(subject.enrollKey).trim()
      ) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid enroll key" });
      }
    }

    subject.enrolledUsers = subject.enrolledUsers || [];
    subject.enrolledUsers.push(req.user._id);
    await subject.save();

    res.json({ success: true, message: "Enrolled successfully" });
  } catch (err) {
    next(err);
  }
};

const deleteSubject = async (req, res, next) => {
  try {
    const { id } = req.params;
    const subject = await Subject.findById(id);
    if (!subject)
      return res
        .status(404)
        .json({ success: false, message: "Course not found" });

    // only the creator may delete
    if (!req.user || String(subject.createdBy) !== String(req.user._id)) {
      return res
        .status(403)
        .json({ success: false, message: "Forbidden: not the owner" });
    }

    // delete quizzes and related questions, then remove the subject
    const quizzes = await Quiz.find({ subject: id }).select("_id");
    const quizIds = quizzes.map((q) => q._id);

    if (quizIds.length > 0) {
      await Question.deleteMany({ quiz: { $in: quizIds } });
      await Quiz.deleteMany({ _id: { $in: quizIds } });
    }

    await Subject.findByIdAndDelete(id);

    res.json({ success: true, message: "Course and related quizzes removed" });
  } catch (err) {
    next(err);
  }
};

export default {
  createSubject,
  getSubjects,
  getSubject,
  enrollSubject,
  deleteSubject,
};
