const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { randomUUID } = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { applicationDefault, cert, getApp, getApps, initializeApp } = require("firebase-admin/app");
const { getAuth: getFirebaseAdminAuth } = require("firebase-admin/auth");
const { DATABASE_URL, SECRET_KEY } = process.env;

let app = express();
app.use(cors({
  origin: true, 
  credentials: true
}));
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

const allowedDiaryImageTypes = new Map([
  ["image/avif", "avif"],
  ["image/gif", "gif"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

let firebaseAdminAuth;
let supabaseClient;

function getAdminAuth() {
  if (!firebaseAdminAuth) {
    let credential;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      try {
        credential = cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
      } catch (error) {
        throw new Error(`FIREBASE_SERVICE_ACCOUNT must contain valid service-account JSON: ${error.message}`);
      }
    } else {
      credential = applicationDefault();
    }

    const app = getApps().length ? getApp() : initializeApp({ credential });
    firebaseAdminAuth = getFirebaseAdminAuth(app);
  }
  return firebaseAdminAuth;
}

function getDiaryImageBucket() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured on the API server");
  }
  if (!supabaseClient) {
    const projectUrl = new URL(process.env.SUPABASE_URL);
    if (projectUrl.pathname === "/rest/v1" || projectUrl.pathname === "/rest/v1/") {
      projectUrl.pathname = "/";
    } else if (projectUrl.pathname !== "/") {
      throw new Error("SUPABASE_URL must be the Supabase Project URL, not a REST endpoint or other path");
    }
    if (projectUrl.search || projectUrl.hash) {
      throw new Error("SUPABASE_URL must not include a query string or fragment");
    }
    supabaseClient = createClient(projectUrl.origin, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return supabaseClient.storage.from(process.env.SUPABASE_DIARY_BUCKET || "diary-images");
}

function isOwnedDiaryImagePath(userId, objectPath) {
  if (typeof objectPath !== "string") return false;
  const [ownerId, fileName, ...extraSegments] = objectPath.split("/");
  return ownerId === userId
    && extraSegments.length === 0
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(avif|gif|jpg|png|webp)$/i.test(fileName);
}

async function requireFirebaseUser(req, res, next) {
  const authorization = req.get("authorization") || "";
  const token = authorization.match(/^Bearer (.+)$/i)?.[1];
  if (!token) {
    return res.status(401).json({ error: "A Firebase sign-in token is required" });
  }

  let adminAuth;
  try {
    adminAuth = getAdminAuth();
  } catch (error) {
    console.error("Firebase Admin configuration failed:", error.message);
    return res.status(500).json({ error: "Firebase Admin authentication is not configured on the API server" });
  }

  try {
    req.auth = await adminAuth.verifyIdToken(token);
    return next();
  } catch (error) {
    console.error("Firebase token verification failed:", error.message);
    res.status(401).json({ error: "Your session is invalid or expired. Please sign in again." });
  }
}

async function removeDiaryImage(userId, objectPath) {
  if (!isOwnedDiaryImagePath(userId, objectPath)) {
    return;
  }
  const { error } = await getDiaryImageBucket().remove([objectPath]);
  if (error) throw new Error(`Supabase image cleanup failed: ${error.message}`);
}

async function getDiaryImageUrl(photoPath, userId) {
  if (!photoPath || /^https?:\/\//i.test(photoPath)) {
    return photoPath;
  }
  if (!isOwnedDiaryImagePath(userId, photoPath)) {
    throw new Error("Diary image path is invalid or does not belong to this user");
  }
  const { data, error } = await getDiaryImageBucket().createSignedUrl(photoPath, 60 * 60);
  if (error) throw new Error(`Supabase signed URL creation failed: ${error.message}`);
  return data.signedUrl;
}

async function withSignedDiaryImage(entry, userId) {
  return { ...entry, photo_url: await getDiaryImageUrl(entry.photo_url, userId) };
}

app.post('/sync-user', async (req, res) => {
  const client = await pool.connect();
  try {
    const { uid, email } = req.body;

    if (!uid) return res.status(400).json({ error: "UID is missing" });

    // Check if user exists
    const userCheck = await client.query('SELECT * FROM travel_users WHERE id = $1', [uid]);

    if (userCheck.rows.length === 0) {
      // If user doesn't exist in Postgres, create them using the Firebase UID
      const username = email.split('@')[0];
      await client.query(
        'INSERT INTO travel_users (id, email, username) VALUES ($1, $2, $3)',
        [uid, email, username]
      );
      console.log(`New user created in Postgres: ${uid}`);
    }

    res.status(200).json({ message: "User synced successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Trips
app.post('/trips', async (req, res) => {
  const client = await pool.connect();
  try {
    const { userId, name, destination, startDate, endDate } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    const query = `INSERT INTO trips (user_id, name, destination, start_date, end_date) VALUES ($1, $2, $3, $4, $5) RETURNING id`;
    const params = [userId, name, destination, startDate, endDate];
    const result = await client.query(query, params);

    res.json({ status: "success", data: result.rows[0], message: "Trip created successfully" });
  } catch (error) {
    if (error.code === "23514") {
      return res.status(400).json({ error: "End date must be on or after start date" });
    }
    console.error("Backend Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// READ all trips (optionally) filtered by user
app.get('/trips', async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.query.userId;
    let query = 'SELECT * FROM trips';
    const params = [];
    if (userId) {
      query += ' WHERE user_id = $1';
      params.push(userId);
    }
    query += " ORDER BY start_date";
    const result = await client.query(query, params);
    res.json({ status: "success", data: result.rows });
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.get("/trips/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const query = "SELECT * FROM trips WHERE id = $1";
    const result = await client.query(query, [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Trip not found" });
    }
    res.json({
      status: "success",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.put("/trips/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const data = {
      name: req.body.name,
      destination: req.body.destination,
      startDate: req.body.startDate,
      endDate: req.body.endDate
    };
    const query = `UPDATE trips SET name = $1, destination = $2, start_date = $3, end_date = $4 WHERE id = $5 RETURNING *`;
    const params = [data.name, data.destination, data.startDate, data.endDate, req.params.id];
    const result = await client.query(query, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Trip not found" });
    }
    console.log(`Trip ${req.params.id} updated successfully`);
    res.json({
      status: "success",
      data: result.rows[0],
      message: "Trip updated successfully",
    });
  } catch (error) {
    if (error.code === "23514") {
      return res.status(400).json({ error: "End date must be on or after start date" });
    }
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.delete("/trips/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const query = "DELETE FROM trips WHERE id = $1 RETURNING id";
    const result = await client.query(query, [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Trip not found" });
    }
    console.log(`Trip ${req.params.id} deleted successfully`);
    res.json({
      status: "success",
      message: "Trip deleted successfully",
    });
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Diary Entry
app.post('/diary-image-uploads', requireFirebaseUser, async (req, res) => {
  const { tripId, contentType } = req.body;
  const extension = allowedDiaryImageTypes.get(contentType);
  if (!tripId || !extension) {
    return res.status(400).json({ error: "A trip and supported image type are required" });
  }

  try {
    const trip = await pool.query(
      "SELECT id FROM trips WHERE id = $1 AND user_id = $2",
      [tripId, req.auth.uid]
    );
    if (!trip.rows.length) {
      return res.status(404).json({ error: "Trip not found" });
    }

    const photoPath = `${req.auth.uid}/${randomUUID()}.${extension}`;
    const { data, error } = await getDiaryImageBucket().createSignedUploadUrl(photoPath, { upsert: false });
    if (error) throw new Error(`Supabase upload authorization failed: ${error.message}`);
    res.json({
      status: "success",
      data: { path: data.path, token: data.token },
    });
  } catch (error) {
    console.error("Diary image upload authorization failed:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/diary-entries', requireFirebaseUser, async (req, res) => {
  const { tripId, caption, photoPath } = req.body;
  if (!tripId || !caption || !isOwnedDiaryImagePath(req.auth.uid, photoPath)) {
    return res.status(400).json({ error: "Trip, caption, and an owned image are required" });
  }

  try {
    const trip = await pool.query(
      "SELECT id FROM trips WHERE id = $1 AND user_id = $2",
      [tripId, req.auth.uid]
    );
    if (!trip.rows.length) {
      return res.status(404).json({ error: "Trip not found" });
    }

    const photoUrl = await getDiaryImageUrl(photoPath, req.auth.uid);
    const result = await pool.query(
      `INSERT INTO diary_entries (trip_id, caption, photo_url)
       VALUES ($1, $2, $3)
       RETURNING id, trip_id, caption, photo_url, date_created`,
      [tripId, caption, photoPath]
    );
    const data = { ...result.rows[0], photo_url: photoUrl };
    res.json({ status: "success", data, message: "Diary entry created successfully" });
  } catch (error) {
    console.error("Diary entry creation failed:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/diary-entries', requireFirebaseUser, async (req, res) => {
  try {
    const params = [req.auth.uid];
    let query = `
      SELECT de.*, t.name AS trip_name
      FROM diary_entries de
      JOIN trips t ON de.trip_id = t.id
      WHERE t.user_id = $1
    `;

    if (req.query.tripId && req.query.tripId !== "null") {
      query += " AND de.trip_id = $2";
      params.push(req.query.tripId);
    }

    query += " ORDER BY de.date_created DESC";
    const result = await pool.query(query, params);
    const data = await Promise.all(result.rows.map((entry) => withSignedDiaryImage(entry, req.auth.uid)));
    res.json({ status: "success", data });
  } catch (error) {
    console.error("Diary entries fetch failed:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.put('/diary-entries/:id', requireFirebaseUser, async (req, res) => {
  try {
    const existing = await pool.query(
      `SELECT de.*
       FROM diary_entries de
       JOIN trips t ON de.trip_id = t.id
       WHERE de.id = $1 AND t.user_id = $2`,
      [req.params.id, req.auth.uid]
    );
    if (!existing.rows.length) {
      return res.status(404).json({ error: "Diary entry not found" });
    }
    if (!req.body.caption) {
      return res.status(400).json({ error: "A caption is required" });
    }

    const oldPhotoPath = existing.rows[0].photo_url;
    const newPhotoPath = req.body.photoPath || oldPhotoPath;
    if (!newPhotoPath
      || (newPhotoPath !== oldPhotoPath && !isOwnedDiaryImagePath(req.auth.uid, newPhotoPath))) {
      return res.status(400).json({ error: "The image does not belong to this user" });
    }
    const photoUrl = await getDiaryImageUrl(newPhotoPath, req.auth.uid);
    const result = await pool.query(
      `UPDATE diary_entries
       SET caption = $1, photo_url = $2
       WHERE id = $3
       RETURNING *`,
      [req.body.caption, newPhotoPath, req.params.id]
    );
    const data = { ...result.rows[0], photo_url: photoUrl };

    if (oldPhotoPath !== newPhotoPath) {
      try {
        await removeDiaryImage(req.auth.uid, oldPhotoPath);
      } catch (cleanupError) {
        console.error(cleanupError.message);
      }
    }
    res.json({ status: "success", data, message: "Diary entry updated successfully" });
  } catch (error) {
    console.error("Diary entry update failed:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.delete("/diary-entries/:id", requireFirebaseUser, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM diary_entries de
       USING trips t
       WHERE de.trip_id = t.id AND de.id = $1 AND t.user_id = $2
       RETURNING de.photo_url`,
      [req.params.id, req.auth.uid]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: "Diary entry not found" });
    }

    let warning;
    try {
      await removeDiaryImage(req.auth.uid, result.rows[0].photo_url);
    } catch (error) {
      console.error(error.message);
      warning = "The entry was deleted, but its stored image could not be removed";
    }
    res.json({ status: "success", message: "Diary entry deleted successfully", warning });
  } catch (error) {
    console.error("Diary entry deletion failed:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// To Do
app.post('/todos', async (req, res) => {
  const client = await pool.connect();
  try {
    const data = {
      tripId: req.body.tripId,
      task_description: req.body.task_description,
      is_completed: req.body.is_completed || false
    };

    const query = `INSERT INTO todos (trip_id, task_description, is_completed) VALUES ($1, $2, $3) RETURNING id`;
    const params = [data.tripId, data.task_description, data.is_completed];
    const result = await client.query(query, params);

    res.json({ status: "success", data: result.rows[0], message: "Todo created successfully" });
  } catch (error) {
    if (error.code === "23503") {
      return res.status(400).json({ error: "That trip doesn't exist" });
    }
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.get('/todos', async (req, res) => {
  const client = await pool.connect();
  try {
    const { tripId, userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    let query = `
      SELECT t.* FROM todos t
      JOIN trips tr ON t.trip_id = tr.id
      WHERE tr.user_id = $1
    `;
    const params = [userId];

    if (tripId && tripId !== 'null') {
      query += " AND t.trip_id = $2";
      params.push(tripId);
    }

    query += " ORDER BY t.is_completed, t.id";
    const result = await client.query(query, params);
    res.json({ status: "success", data: result.rows });
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.get("/todos/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const query = "SELECT * FROM todos WHERE id = $1";
    const result = await client.query(query, [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Todo not found" });
    }
    res.json({
      status: "success",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.put("/todos/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const data = {
      task_description: req.body.task_description,
      is_completed: req.body.is_completed
    };
    const query = `UPDATE todos SET task_description = $1, is_completed = $2 WHERE id = $3 RETURNING *`;
    const params = [data.task_description, data.is_completed, req.params.id];
    const result = await client.query(query, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Todo not found" });
    }
    console.log(`Todo ${req.params.id} updated successfully`);
    res.json({
      status: "success",
      data: result.rows[0],
      message: "Todo updated successfully",
    });
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.delete("/todos/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const query = "DELETE FROM todos WHERE id = $1 RETURNING id";
    const result = await client.query(query, [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Todo not found" });
    }
    console.log(`Todo ${req.params.id} deleted successfully`);
    res.json({ status: "success", message: "Todo deleted successfully" });
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.get("/activities", async (req, res) => {
  try {
    const { latitude, longitude } = req.query;
    if (!latitude || !longitude) {
      return res.status(400).json({ error: "latitude and longitude are required" });
    }

    // List of multiple Overpass API mirrors to try if one is busy
    const overpassInstances = [
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter",
      "https://lz4.overpass-api.de/api/interpreter",
      "https://z.overpass-api.de/api/interpreter"
    ];

    // Optimized Query: Searching for nodes within 5km
    // We removed the complex regex "~" where possible to make it faster
    const query = `
      [out:json][timeout:25];
      (
        node["tourism"~"attraction|museum|viewpoint"](around:5000,${latitude},${longitude});
        node["amenity"~"arts_centre|theatre"](around:5000,${latitude},${longitude});
      );
      out body 15;
    `;

    let lastError = null;

    // Loop through instances until one works
    for (const instance of overpassInstances) {
      try {
        console.log(`Trying Overpass instance: ${instance}`);
        const response = await fetch(instance, {
          method: "POST",
          headers: {
            "User-Agent": "TravelPlannerApp/1.0",
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: new URLSearchParams({ data: query }),
        });

        if (response.ok) {
          const result = await response.json();
          const formattedActivities = (result.elements || [])
            .filter(el => el.tags && el.tags.name)
            .map(el => ({
              id: el.id,
              name: el.tags.name,
              category: el.tags.tourism || el.tags.amenity || "Activity",
              website: el.tags.website || el.tags["contact:website"] || null,
            }));

          console.log(`Success using ${instance}`);
          return res.json({ status: "success", data: formattedActivities });
        } else {
          const errorText = await response.text();
          console.warn(`Instance ${instance} failed: ${response.status}`);
        }
      } catch (err) {
        lastError = err;
        console.error(`Connection error for ${instance}:`, err.message);
      }
    }

    // If all instances fail
    res.status(503).json({
      error: "All map servers are currently busy. Please try again in a few seconds.",
      details: lastError?.message
    });

  } catch (error) {
    console.error("Internal Server Error in /activities ", error.message);
    res.status(500).json({ error: error.message });
  }
});

// index.js

// index.js

app.get("/locations", async (req, res) => {
  try {
    const { keyword } = req.query;
    if (!keyword || keyword.length < 3) {
      return res.status(400).json({ error: "keyword must be at least 3 characters" });
    }

    // Using Photon API (Mirror of OpenStreetMap data)
    // No API key required, much more reliable for development
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(keyword)}&limit=5`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Location provider returned status ${response.status}`);
    }

    const data = await response.json();

    // Photon returns GeoJSON format: data.features
    const formattedData = data.features.map(item => {
      const { name, city, state, country } = item.properties;
      
      // Create a nice display name: "Paris, France" or "Eiffel Tower, Paris, France"
      const displayName = [name, city, state, country]
        .filter(Boolean) // Remove null/undefined
        .filter((val, index, self) => self.indexOf(val) === index) // Remove duplicates
        .join(", ");

      return {
        name: displayName,
        geoCode: {
          // IMPORTANT: Photon returns [longitude, latitude]
          // We must flip them to match your frontend [latitude, longitude]
          latitude: item.geometry.coordinates[1],
          longitude: item.geometry.coordinates[0]
        }
      };
    });

    res.json({ status: "success", data: formattedData });
  } catch (error) {
    console.error("Location Search Error:", error.message);
    res.status(500).json({ error: "Could not find locations. Please try again." });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/*app.listen(3000, () => {
  console.log('App is listenig on port 3000');
});*/

if (process.env.NODE_ENV !== 'production') {
  app.listen(3000, () => {
    console.log('App is listening on port 3000');
  });
}

module.exports = app;