import mongoose from "mongoose";

const SubjectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, unique: true },
    enrollKey: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    enrolledUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

const Subject = mongoose.model("Subject", SubjectSchema);

export default Subject;
