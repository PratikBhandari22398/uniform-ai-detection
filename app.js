require("dotenv").config();
const express = require("express");
const path = require("path");
const mongoose = require("mongoose");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const multer = require("multer");
const fs = require("fs");
const tf = require("@tensorflow/tfjs-node");

const app = express();

/* ===================== MODELS ===================== */
const User = require("./models/user");
const Detection = require("./models/detection");

/* ===================== CONFIG ===================== */
const PORT = process.env.PORT || 3000;
const MONGODB_URI =
  process.env.MONGO_URI || "mongodb://localhost:27017/uniformpro";

/* Teacher credentials */
const TEACHER_ID = process.env.TEACHER_ID || "teacher123";
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || "teacher@999";

/* ===================== VIEW ENGINE ===================== */
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

/* ===================== STATIC ===================== */
app.use(express.static(path.join(__dirname, "public")));

/* ===================== BODY PARSER ===================== */
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "10mb" }));

/* ===================== DATABASE ===================== */
mongoose
  .connect(MONGODB_URI)
  .then(() => console.log("🟢 MongoDB Connected"))
  .catch((err) => console.error("🔴 Mongo Error:", err));

/* ===================== SESSION ===================== */
app.use(
  session({
    secret: process.env.SESSION_SECRET || "uniform-secret",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: MONGODB_URI }),
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 },
  })
);

/* ===================== GLOBAL USER ===================== */
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.isTeacher = req.session.isTeacher || false;
  next();
});

/* ===================== AUTH HELPERS ===================== */
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

function requireTeacher(req, res, next) {
  if (!req.session.isTeacher) return res.redirect("/teacher-login");
  next();
}

/* ===================== ROUTES ===================== */

/* ---------- HOME ---------- */
app.get("/", (req, res) => res.render("home"));

/* ---------- SIGNUP ---------- */
app.get("/signup", (req, res) => {
  if (req.session.user) return res.redirect("/detect");
  res.render("users/signup");
});

app.post("/signup", async (req, res) => {
  const { username, email, password, department, year, division } = req.body;

  try {
    const user = await User.create({
      username,
      email,
      password,
      department,
      year,
      division,
      role: "student",
    });

    req.session.user = user;
    res.redirect("/detect");
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).render("users/signup", {
      error: "Username or email already exists",
    });
  }
});

/* ---------- LOGIN ---------- */
app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/detect");
  res.render("users/login");
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await User.findOne({ username, password });
    if (!user) {
      return res
        .status(400)
        .render("users/login", { error: "Invalid username or password" });
    }

    req.session.user = user;
    res.redirect("/detect");
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).send("Server error");
  }
});

/* ---------- LOGOUT ---------- */
app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

/* ---------- DETECT ---------- */
app.get("/detect", requireLogin, async (req, res) => {
  const history = await Detection.find({ user: req.session.user._id })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  res.render("detect", { history });
});

/* ===================== TEACHER ===================== */

/* ---------- TEACHER LOGIN ---------- */
app.get("/teacher-login", (req, res) =>
  res.render("users/teacher-login")
);

app.post("/teacher-login", (req, res) => {
  const { teacherId, password } = req.body;

  if (teacherId === TEACHER_ID && password === TEACHER_PASSWORD) {
    req.session.isTeacher = true;
    return res.redirect("/teacher/students");
  }

  res.render("users/teacher-login", {
    error: "Invalid teacher credentials",
  });
});

/* ---------- TEACHER LOGOUT ---------- */
app.post("/teacher-logout", (req, res) => {
  req.session.isTeacher = false;
  res.redirect("/");
});

/* ---------- TEACHER DASHBOARD (FILTERS) ---------- */
app.get("/teacher/students", requireTeacher, async (req, res) => {
  const { department, year, division } = req.query;

  const filter = { role: "student" };
  if (department) filter.department = department;
  if (year) filter.year = year;
  if (division) filter.division = division;

  const students = await User.find(filter).sort({ createdAt: -1 }).lean();

  const detections = await Detection.aggregate([
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$user",
        lastIsCompliant: { $first: "$isCompliant" },
        lastAt: { $first: "$createdAt" },
      },
    },
  ]);

  const uniformMap = {};
  detections.forEach((d) => {
    uniformMap[d._id.toString()] = d;
  });

  res.render("users/teacher-students", {
    students,
    uniformMap,
    filters: { department, year, division },
  });
});

/* ---------- TEACHER CSV EXPORT (FIXED) ---------- */
app.get("/teacher/students/export", requireTeacher, async (req, res) => {
  const students = await User.find({ role: "student" }).lean();

  const detections = await Detection.aggregate([
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$user",
        lastIsCompliant: { $first: "$isCompliant" },
        lastAt: { $first: "$createdAt" },
      },
    },
  ]);

  const map = {};
  detections.forEach((d) => (map[d._id.toString()] = d));

  let csv =
    "Username,Email,Department,Year,Division,Uniform Status,Last Checked\n";

  students.forEach((s) => {
    const info = map[s._id.toString()];
    const status = info
      ? info.lastIsCompliant
        ? "Uniform OK"
        : "Not in Uniform"
      : "No Data";

    csv += `"${s.username}","${s.email}","${s.department}","${s.year}","${s.division}","${status}","${info?.lastAt || ""}"\n`;
  });

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    "attachment; filename=students_uniform_report.csv"
  );

  res.send(csv);
});

/* ===================== IMAGE UPLOAD ===================== */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "public/uploads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) =>
    cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

/* ===================== ML MODEL ===================== */
let model = null;
(async () => {
  try {
    const modelPath =
      "file://" + path.join(__dirname, "tfjs_model/model.json");
    model = await tf.loadLayersModel(modelPath);
    console.log("✅ ML Model Loaded");
  } catch (err) {
    console.error("❌ ML Load Error:", err.message);
  }
})();

/* ---------- IMAGE DETECT ---------- */
app.post(
  "/detect-image",
  requireLogin,
  upload.single("image"),
  async (req, res) => {
    if (!model) return res.status(500).json({ error: "Model not ready" });

    const buffer = fs.readFileSync(req.file.path);

    const tensor = tf.node
      .decodeImage(buffer, 3)
      .resizeNearestNeighbor([224, 224])
      .expandDims()
      .toFloat()
      .div(tf.scalar(255));

    const preds = model.predict(tensor);
    const data = preds.dataSync();

    const maxIdx = data.indexOf(Math.max(...data));
    const label = maxIdx === 0 ? "uniform" : "not-uniform";
    const confidence = data[maxIdx];

    await Detection.create({
      user: req.session.user._id,
      username: req.session.user.username,
      label,
      confidence,
      isCompliant: label === "uniform",
      source: "upload",
    });

    tf.dispose([tensor, preds]);

    res.json({ label, confidence });
  }
);

/* ===================== 404 ===================== */
app.use((req, res) => res.status(404).send("404 Not Found"));

/* ===================== START ===================== */
app.listen(PORT, () =>
  console.log(`🚀 Server running at http://localhost:${PORT}`)
);
