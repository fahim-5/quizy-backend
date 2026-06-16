import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

dotenv.config();
const MONGO =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ;
  

const UserSchema = new mongoose.Schema(
  {
    name: String,
    identifier: { type: String, required: true, unique: true },
    password: String,
    role: {
      type: String,
      enum: ["student", "teacher"],
      default: "student",
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

const QuizSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: String,
  timeLimit: { type: Number, default: 0 },
  rules: { type: String },
  createdAt: { type: Date, default: Date.now },
});

const SubjectSchema = new mongoose.Schema({
  name: String,
  code: { type: String, unique: true },
  enrollKey: String,
  createdAt: { type: Date, default: Date.now },
});

const QuestionSchema = new mongoose.Schema({
  quiz: { type: mongoose.Schema.Types.ObjectId, ref: "Quiz", required: true },
  text: { type: String, required: true },
  options: [{ text: String }],
  correctIndex: { type: Number },
  points: { type: Number, default: 1 },
});

const ResultSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  quiz: { type: mongoose.Schema.Types.ObjectId, ref: "Quiz", required: true },
  score: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  answers: [
    {
      question: { type: mongoose.Schema.Types.ObjectId, ref: "Question" },
      answerIndex: Number,
    },
  ],
  takenAt: { type: Date, default: Date.now },
});


const User = mongoose.models.User || mongoose.model("User", UserSchema);
const Quiz = mongoose.models.Quiz || mongoose.model("Quiz", QuizSchema);
const Subject =
  mongoose.models.Subject || mongoose.model("Subject", SubjectSchema);
const Question =
  mongoose.models.Question || mongoose.model("Question", QuestionSchema);
const Result = mongoose.models.Result || mongoose.model("Result", ResultSchema);

async function appendSample() {
  await mongoose.connect(MONGO);
  console.log("Connected to", MONGO);

  
  const usersToEnsure = [
    {
      identifier: "student03",
      name: "Student Three",
      role: "student",
      password: "student3",
    },
    {
      identifier: "student04",
      name: "Student Four",
      role: "student",
      password: "student4",
    },
    {
      identifier: "student05",
      name: "Student Five",
      role: "student",
      password: "student5",
    },
    {
      identifier: "teacher02",
      name: "Teacher Two",
      role: "teacher",
      password: "teacher2",
    },
  ];

  for (const u of usersToEnsure) {
    const exists = await User.findOne({ identifier: u.identifier }).lean();
    if (!exists) {
      const hash = await bcrypt.hash(u.password, 12);
      const created = await User.create({
        name: u.name,
        identifier: u.identifier,
        password: hash,
        role: u.role,
      });
      console.log("Created user", created.identifier);
    } else {
      console.log("User exists, skipping", u.identifier);
    }
  }

  // Ensure there's at least 4 quizzes; if less, create additional ones
  const existingQuizzes = await Quiz.find().lean();
  const neededQuizzes = 4 - existingQuizzes.length;
  const newQuizzes = [];
  if (neededQuizzes > 0) {
    for (let i = 0; i < neededQuizzes; i++) {
      // attach to a default subject (create if needed)
      let defaultSubject = await Subject.findOne({ code: "GEN101" });
      if (!defaultSubject) {
        defaultSubject = await Subject.create({
          name: "General",
          code: "GEN101",
          enrollKey: "123456",
        });
      }

      const q = await Quiz.create({
        title: `Sample Quiz ${existingQuizzes.length + i + 1}`,
        description: "Auto-generated sample quiz",
        timeLimit: 600 + i * 300,
        rules: "Follow instructions.",
        subject: defaultSubject._id,
      });
      newQuizzes.push(q);
      console.log("Created quiz", q.title);
    }
  }

  const quizzes = await Quiz.find().limit(10);

  // Create questions for each quiz if less than 5
  for (const quiz of quizzes) {
    const countQ = await Question.countDocuments({ quiz: quiz._id });
    if (countQ >= 5) {
      console.log(`Quiz ${quiz.title} has ${countQ} questions, skipping`);
      continue;
    }
    const base = [
      {
        text: "What does CPU stand for?",
        options: [
          { text: "Central Processing Unit" },
          { text: "Computer Personal Unit" },
          { text: "Central Processor Unit" },
        ],
        correctIndex: 0,
        points: 1,
      },
      {
        text: "What is O(1)?",
        options: [
          { text: "Constant time" },
          { text: "Linear time" },
          { text: "Quadratic time" },
        ],
        correctIndex: 0,
        points: 2,
      },
      {
        text: "Which is a NoSQL DB?",
        options: [{ text: "MongoDB" }, { text: "Postgres" }, { text: "MySQL" }],
        correctIndex: 0,
        points: 1,
      },
      {
        text: "Which sort is stable?",
        options: [
          { text: "Quick sort" },
          { text: "Merge sort" },
          { text: "Heap sort" },
        ],
        correctIndex: 1,
        points: 2,
      },
      {
        text: "Pick the LIFO structure",
        options: [{ text: "Queue" }, { text: "Stack" }, { text: "Graph" }],
        correctIndex: 1,
        points: 1,
      },
    ];
    for (const b of base) {
      await Question.create({
        quiz: quiz._id,
        text: b.text,
        options: b.options,
        correctIndex: b.correctIndex,
        points: b.points,
      });
    }
    console.log(`Added ${base.length} questions to quiz ${quiz.title}`);
  }

  // Create sample results for leaderboard: for each quiz, create random student results
  const students = await User.find({ role: "student" }).limit(50);
  const allQuizzes = await Quiz.find().limit(10);
  for (const quiz of allQuizzes) {
    const questions = await Question.find({ quiz: quiz._id });
    if (!questions.length) continue;
    // create up to 6 results per quiz
    for (let i = 0; i < Math.min(6, students.length); i++) {
      const student = students[i];
      // random answers
      const answers = questions.map((q) => ({
        question: q._id,
        answerIndex: Math.floor(Math.random() * (q.options?.length || 2)),
      }));
      // compute score
      let score = 0;
      let total = 0;
      for (const q of questions) {
        total += q.points || 1;
      }
      // crude scoring: compare random answers to correctIndex
      for (let ai = 0; ai < questions.length; ai++) {
        const q = questions[ai];
        const given = answers[ai].answerIndex;
        if (typeof q.correctIndex === "number" && given === q.correctIndex)
          score += q.points || 1;
      }
      // Do not duplicate identical result for same user+quiz
      const exists = await Result.findOne({
        user: student._id,
        quiz: quiz._id,
      }).lean();
      if (exists) continue;
      await Result.create({
        user: student._id,
        quiz: quiz._id,
        score,
        total,
        answers,
        duration: Math.floor(Math.random() * quiz.timeLimit || 600),
      });
    }
    console.log(`Populated results for quiz ${quiz.title}`);
  }

  const counts = {
    users: await User.countDocuments(),
    quizzes: await Quiz.countDocuments(),
    questions: await Question.countDocuments(),
    results: await Result.countDocuments(),
  };
  console.log("Final counts:", counts);
  await mongoose.disconnect();
  console.log("Disconnected");
}

appendSample().catch((err) => {
  console.error(err);
  process.exit(1);
});
