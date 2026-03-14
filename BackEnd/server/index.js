import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import bcrypt from "bcrypt";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import GoogleStrategy from "passport-google-oauth2";
import session from "express-session";
import dotenv from "dotenv";

dotenv.config();
const app = express();

// ======================= VIEW ENGINE =======================
app.set("view engine", "ejs");
app.set("views", "./views");

// ======================= MIDDLEWARE =======================
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static("public"));
app.use(passport.initialize());
app.use(passport.session());

// ======================= DATABASE =======================
const db = new pg.Client({
  user: process.env.DBUSER,
  host: process.env.DBHOST,
  database: process.env.DBDATABASE,
  password: process.env.DBPASSWORD,
  port: Number(process.env.DBPORT) || 5432,
});
db.connect().then(() => console.log("📌 Connected to PostgreSQL"));

// ======================= ROUTES =======================
app.get("/", (req, res) => res.render("home"));

app.get("/login", (req, res) => {
  res.render("login", { 
    error: req.query.error || null,
    email: req.query.email || ""  
  });
});

app.get("/register", (req, res) => {
  res.render("register", { email: req.query.email || "" });
});

app.get("/logout", (req, res) => {
  req.logout(() => req.session.destroy(() => res.redirect("/")));
});

// ======================= DASHBOARD =======================
app.get("/dashboard", async (req, res) => {
  if (!req.isAuthenticated()) return res.redirect("/login");

  const userId = req.user.id;

  try {
    // ===== Stats from UserCourses =====
    const statsResult = await db.query(
      `SELECT 
        COUNT(*) AS courses_enrolled,
        COALESCE(SUM(completed_hours),0) AS hours_spent,
        COUNT(*) FILTER (WHERE completed_hours >= c.total_hours) AS completed_courses
      FROM UserCourses uc
      JOIN courses c ON uc.course_id = c.id
      WHERE uc.user_id = $1`,
      [userId]
    );

    const stats = statsResult.rows[0] || {
      courses_enrolled: 0,
      hours_spent: 0,
      completed_courses: 0
    };

    // ===== Enrolled courses with progress =====
    const enrolledCoursesResult = await db.query(
      `SELECT uc.id AS enrollment_id, uc.completed_hours, c.id AS course_id, c.title, c.total_hours
       FROM UserCourses uc
       JOIN courses c ON uc.course_id = c.id
       WHERE uc.user_id=$1`,
      [userId]
    );

    // ===== All courses =====
    const allCoursesResult = await db.query("SELECT * FROM courses");
    const allCourses = allCoursesResult.rows;

    // ===== Recommended courses =====
    const recommended = [
      { title: "JavaScript Basics", description: "Perfect to start your learning journey!" },
      { title: "Web Development Bootcamp", description: "Learn HTML, CSS, JS & Backend." },
      { title: "Database Fundamentals", description: "Understand SQL, schemas and queries." }
    ];

    res.render("dashboard", {
      user: req.user,
      stats,
      enrolledCourses: enrolledCoursesResult.rows,
      allCourses,
      recommended,
      cardColor: "#007BFF"
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

// ======================= BLOGS ROUTES =======================

// Show all blogs
app.get("/blogs", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM blogs ORDER BY id DESC");
    res.render("blogs", { blogs: result.rows });
  } catch (err) {
    console.log(err);
    res.send("Error loading blogs");
  }
});

// Show single blog detail
app.get("/blogs/:id", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM blogs WHERE id=$1", [req.params.id]);
    if (result.rows.length === 0) return res.send("Blog not found");
    res.render("blogDetails", { blog: result.rows[0] });
  } catch (err) {
    console.log(err);
    res.send("Error loading blog details");
  }
});

// Create new blog
app.post("/blogs", async (req, res) => {
  const { title, excerpt, content } = req.body;
  try {
    await db.query(
      "INSERT INTO blogs (title, excerpt, content) VALUES ($1, $2, $3)",
      [title, excerpt, content]
    );
    res.redirect("/blogs");
  } catch (err) {
    console.log(err);
    res.send("Error creating blog");
  }
});

// ======================= ABOUT PAGE =======================
app.get("/about", (req, res) => {
  res.render("about");
});

// ======================= ENROLL IN COURSE =======================
app.post("/api/enroll", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ msg: "Unauthorized" });

  const { courseId } = req.body;
  const userId = req.user.id;

  try {
    const exists = await db.query(
      "SELECT * FROM UserCourses WHERE user_id=$1 AND course_id=$2",
      [userId, courseId]
    );
    if (exists.rows.length > 0) return res.status(400).json({ msg: "Already enrolled" });

    const result = await db.query(
      "INSERT INTO UserCourses (user_id, course_id, completed_hours) VALUES ($1,$2,0) RETURNING *",
      [userId, courseId]
    );

    res.json({ success: true, enrollment: result.rows[0] });
  } catch (err) {
    console.log(err);
    res.status(500).json({ msg: "Server Error" });
  }
});

// ======================= UPDATE COMPLETED HOURS =======================
app.put("/api/enrollments/:enrollmentId", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ msg: "Unauthorized" });

  const { enrollmentId } = req.params;
  const { completedHours } = req.body;

  try {
    const result = await db.query(
      "UPDATE UserCourses SET completed_hours=$1 WHERE id=$2 RETURNING *",
      [completedHours, enrollmentId]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.log(err);
    res.status(500).json({ msg: "Server Error" });
  }
});

// ======================= SAVE CARD COLOR =======================
app.post("/api/set-card-color", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ msg: "Unauthorized" });

  const { color } = req.body;
  const userId = req.user.id;

  try {
    await db.query(`
      INSERT INTO ui_settings (user_id, card_color)
      VALUES ($1, $2)
      ON CONFLICT (user_id) DO UPDATE
      SET card_color = EXCLUDED.card_color
    `, [userId, color]);

    res.json({ success: true, color });
  } catch (error) {
    console.log(error);
    res.status(500).json({ msg: "Server error" });
  }
});

// ======================= LOCAL LOGIN =======================
passport.use("local", new LocalStrategy(
  { usernameField: "email", passwordField: "password" },
  async (email, password, done) => {
    try {
      const result = await db.query("SELECT * FROM users WHERE email=$1", [email]);
      if (!result.rows.length) return done(null, false);

      bcrypt.compare(password, result.rows[0].password, (err, matched) =>
        matched ? done(null, result.rows[0]) : done(null, false)
      );
    } catch (err) {
      done(err);
    }
  }
));

app.post("/login", async (req, res, next) => {
  const { email } = req.body;
  try {
    const user = await db.query("SELECT * FROM users WHERE email=$1", [email]);
    if (!user.rows.length)
      return res.redirect(`/register?email=${encodeURIComponent(email)}`);

    passport.authenticate("local", (err, userData) => {
      if (err) return next(err);
      if (!userData)
        return res.redirect(`/login?error=Invalid password&email=${encodeURIComponent(email)}`);

      req.login(userData, err => {
        if (err) return next(err);
        return res.redirect("/dashboard");
      });
    })(req, res, next);

  } catch (error) {
    console.log("Login Error:", error);
    res.send("Login Failed");
  }
});

// ======================= REGISTER =======================
app.post("/register", async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const existing = await db.query("SELECT * FROM users WHERE email=$1", [email]);
    if (existing.rows.length > 0) return res.redirect("/login");

    const hash = await bcrypt.hash(password, 10);
    const newUser = await db.query(
      "INSERT INTO users(name,email,password) VALUES($1,$2,$3) RETURNING *",
      [name, email, hash]
    );

    req.login(newUser.rows[0], () => res.redirect("/dashboard"));
  } catch (error) {
    console.log("Register Error:", error);
    res.send("Registration Failed");
  }
});

// ======================= GOOGLE AUTH =======================
passport.use("google", new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.NODE_ENV === "production"
    ? process.env.GOOGLE_CALLBACK_PROD
    : process.env.GOOGLE_CALLBACK_LOCAL,
  userProfileURL: "https://www.googleapis.com/oauth2/v3/userinfo"
},
async (accessToken, refreshToken, profile, done) => {
  try {
    const user = await db.query("SELECT * FROM users WHERE email=$1", [profile.email]);

    if (!user.rows.length) {
      const newUser = await db.query(
        "INSERT INTO users(name,email,password) VALUES($1,$2,$3) RETURNING *",
        [profile.displayName, profile.email, "google"]
      );

      return done(null, newUser.rows[0]);
    }
    return done(null, user.rows[0]);
  } catch (err) {
    return done(err);
  }
}));

app.get("/auth/google",
  passport.authenticate("google", { scope: ["email", "profile"], prompt: "select_account" })
);

app.get("/auth/google/dashboard",
  passport.authenticate("google", { failureRedirect: "/login" }),
  (req, res) => res.redirect("/dashboard")
);

// ======================= SESSION HANDLERS =======================
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ======================= START SERVER =======================
app.listen(3000, () => console.log("🚀 Server running at http://localhost:3000"));
