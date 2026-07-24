const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { DATABASE_URL, SECRET_KEY } = process.env;

let app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

async function getPostgresVersion() {
  const client = await pool.connect();
  try {
    const response = await client.query("SELECT version()");
    console.log(response.rows[0]);
  } finally {
    client.release();
  }
}

getPostgresVersion();

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
app.post('/diary-entries', async (req, res) => {
  const client = await pool.connect();
  try {
    const { tripId, caption, photoUrl } = req.body;

    const query = `INSERT INTO diary_entries (trip_id, caption, photo_url) VALUES ($1, $2, $3) RETURNING id, date_created`;
    const params = [tripId, caption, photoUrl];
    const result = await client.query(query, params);

    res.json({ status: "success", data: result.rows[0], message: "Diary entry created successfully", });
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.get('/diary-entries', async (req, res) => {
  const client = await pool.connect();
  try {
    const { tripId, userId } = req.query; // Get both from query
    let query = `
      SELECT de.*, t.name as trip_name 
      FROM diary_entries de 
      JOIN trips t ON de.trip_id = t.id
    `;
    const params = [];

    if (tripId) {
      query += " WHERE de.trip_id = $1";
      params.push(tripId);
    } else if (userId) {
      // General view: show everything for this user
      query += " WHERE t.user_id = $1";
      params.push(userId);
    }

    query += " ORDER BY de.date_created DESC";
    const result = await client.query(query, params);
    res.json({ status: "success", data: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// index.js

app.get('/diary-entries', async (req, res) => {
  const client = await pool.connect();
  try {
    const { tripId, userId } = req.query; // Get both from query
    let query = '';
    let params = [];

    if (tripId && tripId !== 'null') {
      // 1. Fetch for a specific trip
      query = 'SELECT * FROM diary_entries WHERE trip_id = $1 ORDER BY date_created DESC';
      params = [tripId];
    } else if (userId) {
      // 2. "General View": Join with trips table to get all entries for this user
      query = `
        SELECT de.* FROM diary_entries de
        JOIN trips t ON de.trip_id = t.id
        WHERE t.user_id = $1
        ORDER BY de.date_created DESC
      `;
      params = [userId];
    } else {
      return res.status(400).json({ error: "Missing tripId or userId" });
    }

    const result = await client.query(query, params);
    res.json({ status: "success", data: result.rows });
  } catch (error) {
    console.error('Error: ', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.put('/diary-entries/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const data = {
      caption: req.body.caption,
      photoUrl: req.body.photoUrl
    };
    const query = `UPDATE diary_entries SET caption = $1, photo_url = $2 WHERE id = $3 RETURNING *`;
    const params = [data.caption, data.photoUrl, req.params.id];
    const result = await client.query(query, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Entry not found" });
    }
    console.log(`Diary entry ${req.params.id} updated successfuly`);
    res.json({ status: "success", data: result.rows[0], message: "Diary entry updated successfully" });
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.delete("/diary-entries/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const query = "DELETE FROM diary_entries WHERE id = $1 RETURNING id";
    const result = await client.query(query, [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Trip not found" });
    }
    console.log(`Diary entry ${req.params.id} deleted successfully`);
    res.json({
      status: "success",
      message: "Diary entry deleted successfully",
    });
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
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

module.exports = app;