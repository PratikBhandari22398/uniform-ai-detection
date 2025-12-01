// app.js (modified from your original)
// - exposes currentUser to EJS
// - redirects logged-in users away from /login and /signup
// - stores username in session
// - protects /detect
require("dotenv").config();
const express = require("express");
const path = require("path");
const mongoose = require("mongoose");
const session = require("express-session");
const MongoStore = require("connect-mongo");

const app = express();
const User = require("./models/user");

/* ---- VIEW ENGINE ---- */
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

/* ---- STATIC ---- */
app.use(express.static(path.join(__dirname, "public")));

/* ---- BODY PARSERS ---- */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ---- MONGO CONNECT ---- */
const MONGODB_URI = process.env.MONGO_URI || "mongodb://localhost:27017/test";

mongoose
  .connect(MONGODB_URI)
  .then(() => console.log("🟢 MongoDB connected"))
  .catch((err) => console.error("🔴 MongoDB error:", err));

/* ---- SESSION SETUP ---- */
app.use(
  session({
    secret: process.env.SESSION_SECRET || "supersecretkey",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: MONGODB_URI,
      ttl: 14 * 24 * 60 * 60, // 14 days
    }),
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  })
);

/* ---- EXPOSE USER TO VIEWS ----
   This makes `currentUser` available inside all EJS templates.
   Use <% if (currentUser) { %> ... <% } %> in nav.ejs
*/
app.use((req, res, next) => {
  if (req.session && req.session.userId) {
    res.locals.currentUser = {
      id: req.session.userId,
      username: req.session.username || null,
    };
  } else {
    res.locals.currentUser = null;
  }
  next();
});

/* ---- SIMPLE AUTH HELPERS ---- */
function requireLogin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.redirect("/login");
  }
  next();
}

/* ---- ROUTES ---- */
app.get("/", (req, res) => {
  res.render("home");
});

/* If already logged-in, redirect away from signup/login */
app.get("/signup", (req, res) => {
  if (req.session && req.session.userId) return res.redirect("/detect");
  res.render("users/signup");
});

app.get("/login", (req, res) => {
  if (req.session && req.session.userId) return res.redirect("/detect");
  res.render("users/login");
});

/* ---- SIGNUP ---- */
app.post("/signup", async (req, res) => {
  const { username, email, password } = req.body;

  try {
    // TODO: For production, hash the password before saving.
    const user = new User({ username, email, password });
    await user.save();

    // Save user info in session (so nav can show username and hide login/signup)
    req.session.userId = user._id;
    req.session.username = user.username;

    res.redirect("/detect");
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).send("Username or email already exists.");
    }
    console.error(err);
    res.status(500).send("Server error.");
  }
});

/* ---- LOGIN ---- */
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await User.findOne({ username });

    // NOTE: currently comparing plaintext passwords.
    // In production, store hashed passwords and use bcrypt.compare().
    if (!user || user.password !== password) {
      return res.status(400).send("Invalid username or password.");
    }

    // Save username & id in session
    req.session.userId = user._id;
    req.session.username = user.username;

    res.redirect("/detect");
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error.");
  }
});

/* ---- LOGOUT ---- */
app.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    res.clearCookie("connect.sid");
    return res.redirect("/");
  });
});

/* ---- PROTECTED ROUTE: detect ---- */
app.get("/detect", requireLogin, (req, res) => {
  res.render("detect");
});

/* ---- 404 ---- */
app.use((req, res) => res.status(404).send("404 - Not Found"));

/* ---- ERROR HANDLER ---- */
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send("500 - Server error");
});

/* ---- START SERVER ---- */
const PORT = 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
