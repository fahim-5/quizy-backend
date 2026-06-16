import User from "../models/User.js";
import AppError from "../utils/appError.js";

// @desc    Get all users
// @route   GET /api/users
// @access  Private/Teacher
export const getUsers = async (req, res, next) => {
  try {
    const users = await User.find().select("-password");

    res.status(200).json({
      success: true,
      count: users.length,
      data: users,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Public list of teachers (limited fields)
// @route   GET /api/teachers
// @access  Public
export const getPublicTeachers = async (req, res, next) => {
  try {
    // return teachers with only public fields
    const teachers = await User.find({ role: "teacher" }).select(
      "name email institution _id identifier",
    );

    res
      .status(200)
      .json({ success: true, count: teachers.length, data: teachers });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single user
// @route   GET /api/users/:id
// @access  Private/Teacher
export const getUser = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).select("-password");

    if (!user) {
      return next(new AppError("User not found", 404));
    }

    res.status(200).json({
      success: true,
      data: user,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update user
// @route   PUT /api/users/:id
// @access  Private
export const updateUser = async (req, res, next) => {
  try {
    // Only allow users to update their own profile unless admin
    if (!req.user) return next(new AppError("Not authenticated", 401));
    if (
      req.user.role !== "admin" &&
      String(req.user._id) !== String(req.params.id)
    ) {
      return next(new AppError("Forbidden: cannot update other users", 403));
    }

    const fieldsToUpdate = {
      name: req.body.name,
      email: req.body.email,
      institution: req.body.institution,
    };

    const user = await User.findByIdAndUpdate(req.params.id, fieldsToUpdate, {
      new: true,
      runValidators: true,
    }).select("-password");

    if (!user) {
      return next(new AppError("User not found", 404));
    }

    res.status(200).json({
      success: true,
      data: user,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete user
// @route   DELETE /api/users/:id
// @access  Private/Teacher
export const deleteUser = async (req, res, next) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);

    if (!user) {
      return next(new AppError("User not found", 404));
    }

    res.status(200).json({
      success: true,
      message: "User deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get current logged-in user profile
// @route   GET /api/users/me
// @access  Private
export const getMe = async (req, res, next) => {
  try {
    if (!req.user) {
      return next(new AppError("Not authenticated", 401));
    }
    // reload user without password
    const user = await User.findById(req.user._id).select("-password");
    res.status(200).json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
};

// @desc    Update current logged-in user
// @route   PUT /api/users/me
// @access  Private (owner)
export const updateMe = async (req, res, next) => {
  try {
    if (!req.user) return next(new AppError("Not authenticated", 401));

    const fieldsToUpdate = {
      name: req.body.name,
      email: req.body.email,
      institution: req.body.institution,
    };

    const user = await User.findByIdAndUpdate(req.user._id, fieldsToUpdate, {
      new: true,
      runValidators: true,
    }).select("-password");

    if (!user) {
      return next(new AppError("User not found", 404));
    }

    res.status(200).json({
      success: true,
      data: user,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Change password
// @route   PUT /api/users/:id/password
// @access  Private (owner or admin)
export const changePassword = async (req, res, next) => {
  try {
    if (!req.user) return next(new AppError("Not authenticated", 401));
    if (
      req.user.role !== "admin" &&
      String(req.user._id) !== String(req.params.id)
    ) {
      return next(
        new AppError("Forbidden: cannot change other users' password", 403),
      );
    }
    const { currentPassword, newPassword } = req.body;
    if (
      !newPassword ||
      typeof newPassword !== "string" ||
      newPassword.length < 4
    ) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 4 characters",
      });
    }
    const user = await User.findById(req.params.id).select("+password");
    if (!user) return next(new AppError("User not found", 404));
    // if not admin, verify current password
    if (req.user.role !== "admin") {
      if (!currentPassword)
        return res
          .status(400)
          .json({ success: false, message: "Current password required" });
      const ok = await user.comparePassword(currentPassword);
      if (!ok)
        return res
          .status(400)
          .json({ success: false, message: "Current password is incorrect" });
    }
    user.password = newPassword;
    await user.save();
    res.status(200).json({ success: true, message: "Password updated" });
  } catch (err) {
    next(err);
  }
};

// @desc    Delete current logged-in user (self)
// @route   DELETE /api/users/me
// @access  Private (owner)
export const deleteMe = async (req, res, next) => {
  try {
    if (!req.user) return next(new AppError("Not authenticated", 401));

    const { currentPassword } = req.body;
    if (!currentPassword)
      return res
        .status(400)
        .json({ success: false, message: "Current password required" });

    const user = await User.findById(req.user._id).select("+password");
    if (!user) return next(new AppError("User not found", 404));

    const ok = await user.comparePassword(currentPassword);
    if (!ok)
      return res
        .status(400)
        .json({ success: false, message: "Current password is incorrect" });

    await User.findByIdAndDelete(req.user._id);

    res.status(200).json({ success: true, message: "Account deleted" });
  } catch (err) {
    next(err);
  }
};
