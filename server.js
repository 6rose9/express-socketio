import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import morgan from "morgan";
import { MongoClient, ObjectId } from "mongodb";
import { Server } from "socket.io";
import multer from "multer";
import fs from "fs";
import bcrypt from "bcrypt";
import session from "express-session";
import MongoStore from "connect-mongo";

const app = express();
const port = process.env.PORT || 3000;

// Register view engin, Set EJS as view engine
app.set("view engine", "ejs");

// Set views folder
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.set("views", path.join(__dirname, "views"));

// Use Morgan for logging
app.use(morgan("dev"));

// Middleware to serve files from the public folder as the website root.
app.use(express.static(path.join(__dirname, "public")));

// Serve node_modules files
app.use(
  "/bootstrap",
  express.static(path.join(__dirname, "node_modules/bootstrap/dist")),
);
app.use(
  "/fontawesome",
  express.static(
    path.join(__dirname, "node_modules/@fortawesome/fontawesome-free"),
  ),
);
app.use(
  "/toastify",
  express.static(path.join(__dirname, "node_modules/toastify-js/src")),
);

// Start server
const expressServer = app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

// Socket.IO attached to server
const io = new Server(expressServer, {
  cors: {
    origin: "*", // for dev, in production specify your frontend URL
    methods: ["GET", "POST"],
  },
});

// Socket events
// optional
io.on("connection", (socket) => {
  console.log("Socket connected: " + socket.id);

  socket.on("join-post", (slug) => {
    const roomName = `post:${slug}`;
    socket.join(roomName);

    const count = io.sockets.adapter.rooms.get(roomName)?.size || 0;
    io.to(roomName).emit("post:viewers", count);
  });

  socket.on("leave-post", (slug) => {
    const roomName = `post:${slug}`;
    socket.leave(roomName);

    const count = io.sockets.adapter.rooms.get(roomName)?.size || 0;
    io.to(roomName).emit("post:viewers", count);
  });

  socket.on("disconnect", () => {
    console.log("Socket disconnected: " + socket.id);
  });
});

// Middleware to parse JSON request bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const cluster = process.env.CLUSTER_NAME;
const db_user = process.env.DB_USER;
const db_password = process.env.DB_PASSWORD;
const db_name = process.env.DB_NAME;

// const uri = `mongodb+srv://${db_user}:${db_password}@${cluster}.f5jhagk.mongodb.net/?appName=${cluster}`;
const uri = process.env.MONGODB_URI || `mongodb://127.0.0.1:27017/`;
let client;
let db;

// Helpers
function slugify(title) {
  // [^] = not
  // \w = word character(a-z,A-Z,0-9,_)
  // \s = space
  // g = global
  return String(title)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "") // remove special characters
    .replace(/[\s_-]+/g, "-") // spaces & underscores → dash
    .replace(/^-+|-+$/g, ""); // trim dashes from start/end
}

async function uniqueSlug(collection, baseSlug, ignoreId = null) {
  // new-post-one
  // new-post-one-1
  // new-post-one-2

  let slug = baseSlug;
  let i = 0;

  while (true) {
    const query = ignoreId ? { slug, _id: { $ne: ignoreId } } : { slug }; // $ne = not equal
    const exists = await collection.findOne(query, { projection: { _id: 1 } }); // projection: {_id:1} means only return the _id field
    if (!exists) return slug;

    i += 1;
    slug = `${baseSlug}-${i}`;
  }
}

async function connectToMongoDB() {
  try {
    client = new MongoClient(uri);
    await client.connect();

    db = client.db(db_name);

    console.log("Connected to MongoDB");
  } catch (error) {
    console.error("Error connecting to MongoDB:", error);
    process.exit(1);
  }
}

connectToMongoDB();

// Session
app.use(
  session({
    secret: process.env.SESSION_SECRET || "mysecret",
    resave: false, // don't save session if unmodified
    saveUninitialized: false, // don't create session until something stored
    store: MongoStore.create({
      mongoUrl: uri,
      dbName: db_name,
      collectionName: "sessions",
    }),
    cookie: {
      maxAge: 1000 * 60 * 60 * 24, // 1 day
      httpOnly: true,
    },
  }),
);

// Middleware
app.use((req, res, next) => {
  if (!db) {
    return res.status(503).send("Database connection not established");
  }

  req.db = db;
  req.io = io;

  next();
});

// Make user data available in all EJS views Middleware
app.use((req, res, next) => {
  // console.log(res);
  res.locals.currentUser = req.session.user || null;
  console.log(res.locals);
  next();
});

function isAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login");
  }
  next();
}

// --------------------------------------------------------------------------------------------------------------

const uploadDir = path.join(__dirname, "public/uploads");

// Ensure upload directory exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // my family @ photo 2026!!.jpg to 123456789-my-family-photo-2026.jpg
    const ext = path.extname(file.originalname).toLowerCase();
    const name = slugify(path.basename(file.originalname, ext)) + ext;

    const uniqueName = `${Date.now()}-${name}`;
    cb(null, uniqueName);
  },
});

function fileFilter(req, file, cb) {
  if (!file.mimetype.startsWith("image/")) {
    return cb(new Error("Only image files are allowed!"));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
});

// --------------------------------------------------------------------------------------------------------------

// home
app.get("/", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1); // ignore NaN
    const limit = 3;
    const skip = (page - 1) * limit;

    console.log(req.query);

    const search = (req.query.search || "").trim();

    // $or => any of this conditions
    // i => case-insensitive search
    const filter = search
      ? {
          $or: [
            { title: { $regex: search, $options: "i" } },
            { subtitle: { $regex: search, $options: "i" } },
            { body: { $regex: search, $options: "i" } },
          ],
        }
      : {};

    const posts = await db
      .collection("posts")
      .find(filter)
      .sort({ createdAt: -1 }) // newest first
      .skip(skip)
      .limit(limit)
      .toArray();

    const total = await db.collection("posts").countDocuments(filter);
    const totalPages = Math.max(Math.ceil(total / limit), 1);

    res.render("index", {
      title: "Home Page",
      posts,
      total,
      page,
      totalPages,
      limit,
      search,
    });
  } catch (error) {
    console.log("Error fetching posts from MongoDB", error);
    res.status(500).render("error", {
      title: "Database Error",
      message: "Failed to load posts. Please try again later",
    });
  }
});

// about
app.get("/about", (req, res) => {
  res.render("about", {
    title: "About Us",
  });
});

app.get("/about-us", (req, res) => {
  res.redirect("/about");
});

//--------------------------------------------------------------------------------------------------------------

// auth routes
app.get("/register", (req, res) => {
  res.render("auth/register", {
    title: "Register",
    error: null,
    formData: {},
  });
});

app.post("/register", async (req, res) => {
  const { username, email, password, confirmPassword } = req.body;

  if (!username || !email || !password || !confirmPassword) {
    return res.render("auth/register", {
      title: "Register",
      error: "All fields are required.",
      formData: req.body,
    });
  }

  if (password !== confirmPassword) {
    return res.render("auth/register", {
      title: "Register",
      error: "Passwords do not match.",
      formData: req.body,
    });
  }

  const existingUser = await db.collection("users").findOne({
    email: email.trim().toLowerCase(),
  });

  if (existingUser) {
    return res.render("auth/register", {
      title: "Register",
      error: "Email is already registered.",
      formData: req.body,
    });
  }

  // 10 does not mean password length, it's the salt rounds, higher is more secure but slower
  const hashedPassword = await bcrypt.hash(password, 10);

  const newuser = {
    username: username.trim(),
    email: email.trim().toLowerCase(),
    password: hashedPassword,
    createdAt: new Date(),
  };

  const result = await db.collection("users").insertOne(newuser);

  // Store user info in session
  req.session.user = {
    _id: result.insertedId,
    username: newuser.username,
    email: newuser.email,
  };

  return res.redirect("/");
});

app.get("/login", (req, res) => {
  res.render("auth/login", {
    title: "Login",
    error: null,
    formData: {},
  });
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.render("auth/login", {
      title: "Login",
      error: "Email and password are required.",
      formData: req.body,
    });
  }

  const user = await db.collection("users").findOne({
    email: email.trim().toLowerCase(),
  });

  if (!user) {
    return res.render("auth/login", {
      title: "Login",
      error: "Invalid email or password.",
      formData: req.body,
    });
  }

  const isMatch = await bcrypt.compare(password, user.password);

  if (!isMatch) {
    return res.render("auth/login", {
      title: "Login",
      error: "Invalid email or password.",
      formData: req.body,
    });
  }

  // Store user info in session
  req.session.user = {
    _id: user._id,
    username: user.username,
    email: user.email,
  };

  return res.redirect("/");
});

app.post("/logout", (req, res) => {
  // remove user session
  req.session.destroy((err) => {
    if (err) {
      console.error("Error destroying session:", err);
    }
    res.redirect("/");
  });
});

//--------------------------------------------------------------------------------------------------------------

// post routes
app.get("/posts/create", isAuth, (req, res) => {
  res.render("create", {
    title: "Create New Post",
    error: null,
    formData: {},
  });
});

app.post("/posts/create", isAuth, upload.single("image"), async (req, res) => {
  try {
    const { title, subtitle, body } = req.body;
    console.log("Received form data:", req.body);

    // Validate form data
    if (!title || !subtitle || !body) {
      return res.render("create", {
        title: "Create New Post",
        error: "All fields are required.",
        formData: req.body,
      });
    }

    const baseSlug = slugify(title);

    if (!baseSlug) {
      return res.render("create", {
        title: "Create New Post",
        error: "Title is not valid to generate slug!",
        formData: req.body,
      });
    }

    const postCollection = db.collection("posts");
    const slug = await uniqueSlug(postCollection, baseSlug);

    // multer file info
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

    // prepare post data
    const newPost = {
      slug,
      title: title.trim(),
      subtitle: subtitle.trim(),
      body: body.trim(),
      imageUrl,
      createdAt: new Date(),
    };

    const result = await db.collection("posts").insertOne(newPost);

    // socket io emit
    req.io.emit("post:created", {
      id: result.insertedId,
      ...newPost,
    });

    return res.redirect(`/posts/${slug}`);
  } catch (error) {
    console.error("Error rendering create page:", error);
    res.render("create", {
      title: "Create New Post",
      error: `Failed to load the create page: ${error.message}`,
      formData: req.body,
    });
  }
});

app.get("/posts/:id/edit", isAuth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      res.render("error", {
        title: "Invalid ID",
        message: `Failed to load edit page: ${error.message}`,
      });
    }

    const post = await req.db
      .collection("posts")
      .findOne({ _id: new ObjectId(id) });

    if (!post) {
      return res.render("404", {
        title: "404 Not Found",
      });
    }

    res.render("edit", {
      title: "Edit Post",
      error: null,
      post,
    });
  } catch (error) {
    res.render("error", {
      title: "Server Error",
      message: `Failed to load edit page: ${error.message}`,
    });
  }
});

app.post(
  "/posts/:id/edit",
  isAuth,
  upload.single("image"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { title, subtitle, body } = req.body;

      // check post existance
      const postCollection = req.db.collection("posts");
      const _id = new ObjectId(id);

      const existing = await postCollection.findOne({ _id });

      if (!existing)
        return res.render("404", {
          title: "404 Not Found",
          message: "Invalid ID",
        });

      // validate form data
      if (!title || !subtitle || !body) {
        return res.render("edit", {
          title: "Edit Post",
          error: "All fields are required.",
          post: {
            _id: id,
            title,
            subtitle,
            body,
          },
        });
      }

      // slug
      let slug = existing.slug;
      if (existing.title !== title) {
        const baseSlug = slugify(title);

        if (!baseSlug) {
          return res.render("edit", {
            title: "Edit Post",
            error: "Title is not valid to generate slug!",
            post: {
              _id: id,
              title,
              subtitle,
              body,
            },
          });
        }
        slug = await uniqueSlug(postCollection, baseSlug, _id);
      }

      // multer file info
      let imageUrl = existing.imageUrl;
      if (req.file) {
        // delete old image file if exist
        if (imageUrl) {
          const oldImagePath = path.join(
            __dirname,
            "public",
            imageUrl.replace("/uploads/", "uploads/"),
          );
          fs.unlink(oldImagePath, (err) => {
            if (err) console.error("Failed to delete old image file:", err);
          });
        }

        imageUrl = `/uploads/${req.file.filename}`;
      }

      // prepare post data
      const updateData = {
        title: title.trim(),
        subtitle: subtitle.trim(),
        body: body.trim(),
        slug,
        imageUrl,
        updatedAt: new Date(),
      };

      const result = await req.db
        .collection("posts")
        .updateOne({ _id: new ObjectId(id) }, { $set: updateData });

      if (result.matchedCount === 0) {
        return res.status(404).render("404", {
          title: "404 Not Found",
        });
      }

      // socket io emit
      req.io.emit("post:updated", {
        id,
        ...updateData,
      });

      // redirect to home
      return res.redirect(`/posts/${slug}`);
    } catch (error) {
      console.error("Error rendering edit page:", error);
      res.render("edit", {
        title: "Edit Post",
        error: `Failed to load the edit page: ${error.message}`,
        post: req.body,
      });
    }
  },
);

app.post("/posts/:id/delete", isAuth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).render("error", {
        title: "Invalid ID",
        error: "Post ID is not valid",
      });
    }

    // delete image file if exist
    const post = await req.db
      .collection("posts")
      .findOne({ _id: new ObjectId(id) });

    if (!post) {
      return res.status(404).render("404", { title: "404 Not Found" });
    }

    if (post.imageUrl) {
      const imagePath = path.join(
        __dirname,
        "public",
        post.imageUrl.replace("/uploads/", "uploads/"),
      );
      fs.unlink(imagePath, (err) => {
        if (err) console.error("Failed to delete image file:", err);
      });
    }

    const result = await req.db
      .collection("posts")
      .deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).render("404", { title: "404 Not Found" });
    }

    // socket io emit
    req.io.emit("post:deleted", {
      title: post.title,
    });

    return res.redirect("/");
  } catch (error) {
    console.error("Error delete post", error);
    res.status(500).render("error", {
      title: "Error",
      message: error.message || "Something went wrong!",
    });
  }
});

// single post detail page (slug)
app.get("/posts/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    const post = await req.db.collection("posts").findOne({ slug });

    if (!post) {
      return res.status(404).render("404", { title: "404 Not Found" });
    }

    const comments = await req.db
      .collection("comments")
      .aggregate([
        { $match: { postId: post._id } },
        { $sort: { createdAt: -1 } },
        {
          $lookup: {
            from: "users",
            localField: "userId",
            foreignField: "_id",
            as: "user",
          },
        },
        {
          $unwind: {
            path: "$user",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $project: {
            postId: 1,
            userId: 1,
            message: 1,
            createdAt: 1,
            username: { $ifNull: ["$user.username", "Anonymous"] },
          },
        },
      ])
      .toArray();

    res.render("detail", {
      title: "Post Detail",
      post,
      comments,
      commentError: null,
    });
  } catch (error) {
    console.log("Error fetching post detail", error);
    res.status(500).render("error", {
      title: "Server Error",
      message: error.message || "Something went wrong!",
    });
  }
});

// comment
app.post("/posts/:slug/comments", isAuth, async (req, res) => {
  try {
    const { slug } = req.params;
    const { message } = req.body;

    const post = await req.db.collection("posts").findOne({ slug });

    if (!post) {
      return res.status(404).render("404", {
        title: "404 Not Found",
        message: "Invalid post!",
      });
    }

    if (!message) {
      const comments = await req.db
        .collection("comments")
        .find({ postId: post._id })
        .sort({ createdAt: -1 })
        .toArray();

      return res.render("detail", {
        title: "Post Detail",
        post,
        comments,
        commentError: "Name and message are required",
      });
    }

    // prepare comment
    const newComment = {
      postId: post._id,
      userId: new ObjectId(req.session.user._id),
      message: message.trim(),
      createdAt: new Date(),
    };

    const result = await req.db.collection("comments").insertOne(newComment);

    // Real-time : send to people who are on comments page of the post (room = post slug)
    req.io.to(`post:${slug}`).emit("comment:created", {
      id: result.insertedId,
      slug,
      username: req.session.user.username,
      message: newComment.message,
      createdAt: newComment.createdAt,
    });

    return res.redirect(`/posts/${slug}`);
  } catch (error) {
    console.error("Error creating comment", error);
    res.status(500).render("error", {
      title: "Server Error",
      message: error.message || "Something went wrong!",
    });
  }
});

app.post("/posts/:slug/comments/:id/delete", isAuth, async (req, res) => {
  try {
    const { slug, id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).render("error", {
        title: "Invalid ID",
        error: `Comment ID is not valid`,
      });
    }

    const _id = new ObjectId(id);
    const comment = await req.db.collection("comments").findOne(_id);

    if (!comment)
      return res.status("404").render("404", {
        title: "404 Not Found",
        message: "Comment not found",
      });

    // allow only owner to delete
    if (
      !req.session?.user ||
      req.session?.user?._id !== comment.userId?.toString()
    ) {
      return res.status("403").render("error", {
        title: "403 Forbidden",
        error: `You can delete only your own comment`,
      });
    }

    const result = await req.db
      .collection("comments")
      .deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).render("404", {
        title: "404 Not Found",
        message: "Comment not found",
      });
    }

    req.io.emit("comment:delete", { id });

    return res.redirect(`/posts/${slug}`);
  } catch (error) {
    console.log(error);
    res.status(500).render("error", {
      title: "Server error",
      message: `Failed to delete comment: ${error.message}`,
    });
  }
});
//--------------------------------------------------------------------------------------------------------------

// 404 (note : This should be the last route)
app.use((req, res) => {
  res.status(404).render("404", {
    title: "Page Not Found",
  });
});

process.on("SIGINT", async () => {
  if (client) await client.close();
  console.log("MongoDB connection closed through app termination");
  process.exit(0);
});
