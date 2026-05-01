import 'dotenv/config'
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import morgan from "morgan";
import { MongoClient, ObjectId } from "mongodb";
import { Server } from "socket.io";

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
app.use('/bootstrap', express.static(path.join(__dirname, "node_modules/bootstrap/dist")));
app.use('/fontawesome', express.static(path.join(__dirname, "node_modules/@fortawesome/fontawesome-free")));

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
const uri = process.env.MONGODB_URI ||`mongodb://127.0.0.1:27017/`;
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
    .replace(/[^\w\s]/g, "")     // remove special characters
    .replace(/[\s_-]+/g, "-")    // spaces & underscores → dash
    .replace(/^-+|-+$/g, "");    // trim dashes from start/end
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

// Middleware
app.use((req, res, next) => {
  if (!db) {
    return res.status(503).send("Database connection not established");
  }

  req.db = db;
  req.io = io;

  next();
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
    const filter = search ? {
      $or: [
        { title: { $regex: search, $options: "i" } },
        { subtitle: { $regex: search, $options: "i" } },
        { body: { $regex: search, $options: "i" } },
      ]
    } : {};

    const posts = await db
      .collection("posts")
      .find(filter)
      .sort({ createdAt: -1 }) // newest first
      .skip(skip)
      .limit(limit)
      .toArray();
    
    const total = await db.collection("posts").countDocuments(filter);
    const totalPages = Math.max(Math.ceil(total / limit),1);

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

// post
app.get("/posts/create", (req, res) => {
  res.render("create", {
    title: "Create New Post",
    error: null,
    formData: {},
  });
});

app.post("/posts/create", async (req, res) => {
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
        formData: req.body
      });
    }

    const postCollection = db.collection("posts");
    const slug = await uniqueSlug(postCollection, baseSlug);

    // prepare post data
    const newPost = {
      slug,
      title: title.trim(),
      subtitle: subtitle.trim(),
      body: body.trim(),
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

app.get("/posts/:id/edit", async (req, res) => {
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

app.post("/posts/:id/edit", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, subtitle, body } = req.body;

    // check post existance
    const postCollection = req.db.collection("posts");
    const _id = new ObjectId(id);

    const existing = await postCollection.findOne({ _id });
    
    if (!existing) return res.render("404", {
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
    if(existing.title !== title) {
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

    // prepare post data
    const updateData = {
      title: title.trim(),
      subtitle: subtitle.trim(),
      body: body.trim(),
      slug,
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
});

app.post("/posts/:id/delete", async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).render("error", {
        title: "Invalid ID",
        error: "Post ID is not valid",
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
      id,
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

    res.render("detail", {
      title: "Post Detail",
      post,
    });
  } catch (error) {
    console.log("Error fetching post detail", error);
    res.status(500).render("error", {
      title: "Server Error",
      message: error.message || "Something went wrong!",
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
  if(client) await client.close();
  console.log("MongoDB connection closed through app termination");
  process.exit(0);
});
