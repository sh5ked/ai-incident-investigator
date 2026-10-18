
const express = require("express");
const { MongoClient } = require("mongodb");
const packageInfo = require("./package.json");

const app = express();
const PORT = process.env.PORT || 3001;
const SCENARIO = process.env.SCENARIO || "healthy";
const MONGODB_URI = process.env.MONGODB_URI;

app.use(express.json());

// אוספים לשמירת אירועי לוג בזיכרון.
const events = [];

let mongoClient;
let database;
let ordersCollection;
let investigationsCollection;

// תיעוד אירועי שירות.
function recordEvent(event) {
  events.push(event);

  // שומרים בזיכרון עד 100 אירועים אחרונים.
  if (events.length > 100) {
    events.shift();
  }
}

// מדידת משך הזמן של בקשות HTTP.
app.use((req, res, next) => {
  const startTime = Date.now();

  res.on("finish", () => {
    const durationMs = Date.now() - startTime;

    recordEvent({
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs,
    });

    // התרעה על בקשה שנמשכה 3 שניות ומעלה.
    if (durationMs >= 3000) {
      recordEvent({
        timestamp: new Date().toISOString(),
        type: "performance_warning",
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs,
        message: `Slow response detected: ${durationMs}ms`,
      });
    }
  });

  next();
});

// סימולציה של תרחיש תגובה איטית.
app.use((req, res, next) => {
  if (
    SCENARIO === "slow_response" &&
    req.path !== "/internal/events"
  ) {
    return setTimeout(next, 3000);
  }

  next();
});

// בדיקת תקינות השירות וחיבור MongoDB בפועל.
app.get("/health", async (req, res) => {
  let databaseStatus = "ok";

  try {
    if (SCENARIO === "database_down") {
      throw new Error("Database failure scenario enabled");
    }

    if (!database) {
      throw new Error("Database is not connected");
    }

    await database.command({ ping: 1 });
  } catch {
    databaseStatus = "unavailable";
  }

  const checks = {
    service: "ok",
    database: databaseStatus,
    paymentProvider:
      SCENARIO === "external_service_down"
        ? "unavailable"
        : "ok",
  };

  const healthy = Object.values(checks).every(
    (status) => status === "ok"
  );

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    service: "order-service",
    checks,
    timestamp: new Date().toISOString(),
  });
});

// הצגת גרסת השירות.
app.get("/version", (req, res) => {
  res.status(200).json({
    service: "order-service",
    version: packageInfo.version,
  });
});

// שליפת הזמנות מ-MongoDB.
app.get("/orders", async (req, res) => {
  try {
    const orders = await ordersCollection
      .find({})
      .sort({ _id: -1 })
      .limit(100)
      .toArray();

    res.status(200).json({
      count: orders.length,
      orders: orders.map(({ _id, ...order }) => ({
        id: _id.toString(),
        ...order,
      })),
    });
  } catch {
    recordEvent({
      timestamp: new Date().toISOString(),
      type: "database_error",
      message: "Failed to read orders from MongoDB",
    });

    res.status(503).json({
      error: "Could not retrieve orders",
    });
  }
});

// יצירת הזמנה ושמירתה ב-MongoDB.
app.post("/orders", async (req, res) => {
  const { customerName, product, quantity } = req.body;

  if (
    typeof customerName !== "string" ||
    !customerName.trim() ||
    typeof product !== "string" ||
    !product.trim() ||
    !Number.isInteger(quantity) ||
    quantity < 1
  ) {
    return res.status(400).json({
      error: "Invalid order data",
    });
  }

  const order = {
    customerName: customerName.trim(),
    product: product.trim(),
    quantity,
    createdAt: new Date(),
  };

  try {
    const result = await ordersCollection.insertOne(order);

    res.status(201).json({
      message: "Order created successfully",
      order: {
        id: result.insertedId.toString(),
        ...order,
      },
    });
  } catch {
    recordEvent({
      timestamp: new Date().toISOString(),
      type: "database_error",
      message: "Failed to save order to MongoDB",
    });

    res.status(503).json({
      error: "Could not save order",
    });
  }
});

// שמירת דוח חקירה ב-MongoDB.
app.post("/internal/investigations", async (req, res) => {
  const { question, report } = req.body;

  if (
    typeof question !== "string" ||
    !question.trim() ||
    typeof report !== "string" ||
    !report.trim()
  ) {
    return res.status(400).json({
      error: "Question and report are required",
    });
  }

  try {
    const investigation = {
      question: question.trim(),
      report: report.trim(),
      createdAt: new Date(),
    };

    const result = await investigationsCollection.insertOne(
      investigation
    );

    res.status(201).json({
      success: true,
      id: result.insertedId.toString(),
      createdAt: investigation.createdAt,
    });
  } catch {
    recordEvent({
      timestamp: new Date().toISOString(),
      type: "database_error",
      message: "Failed to save investigation report",
    });

    res.status(503).json({
      error: "Could not save investigation report",
    });
  }
});

// שליפת דוחות חקירה קודמים.
app.get("/internal/investigations", async (req, res) => {
  try {
    const investigations = await investigationsCollection
      .find({})
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    res.status(200).json({
      count: investigations.length,
      investigations: investigations.map(
        ({ _id, ...investigation }) => ({
          id: _id.toString(),
          ...investigation,
        })
      ),
    });
  } catch {
    res.status(503).json({
      error: "Could not retrieve investigation reports",
    });
  }
});

// הצגת אירועי הלוג האחרונים.
app.get("/internal/events", (req, res) => {
  res.status(200).json({
    count: events.length,
    events: events.slice(-50),
  });
});

// חיבור ל-MongoDB והפעלת השירות.
async function startServer() {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is not configured");
  }

  mongoClient = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });

  await mongoClient.connect();

  database = mongoClient.db();
  ordersCollection = database.collection("orders");
  investigationsCollection = database.collection("investigations");

  console.log("Connected to MongoDB successfully");

  app.listen(PORT, () => {
    console.log(`Order service running on port ${PORT}`);
  });
}

startServer().catch(() => {
  // לא מדפיסים פרטי התחברות או מחרוזת חיבור ללוג.
  console.error(
    "Failed to start service: MongoDB connection error"
  );

  process.exit(1);
});
