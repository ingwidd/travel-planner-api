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

app.post('/signup', async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 12);
    
    const userResult = await client.query('SELECT * FROM travel_users WHERE email = $1', [email]);

    if (userResult.rows.length > 0) {
      return res.status(400).json({ message: 'User already exists' });
    }

    await client.query('INSERT INTO travel_users (email, password, username) VALUES ($1, $2, $3)', [email, hashedPassword, username]);
    res.status(201).json({ message: 'User created successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  } 
});

app.post('/login', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM travel_users WHERE email = $1', [req.body.email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const isPasswordValid = await bcrypt.compare(req.body.password, user.password);
    if (!isPasswordValid) return res.status(401).json({ auth: false, token: null });

    var token = jwt.sign({ id: user.id, username: user.username, roles: user.roles }, SECRET_KEY, { expiresIn: 86400 });
    res.json({ auth: true, token: token });
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
    const data = {
      userId: req.body.userId,
      name: req.body.name,
      destination: req.body.destination,
      startDate: req.body.startDate,
      endDate: req.body.endDate
    };

    const query = `INSERT INTO trips (user_id, name, destination, start_date, end_date) VALUES ($1, $2, $3, $4, $5) RETURNING id`;
    const params = [data.userId, data.name, data.destination, data.startDate, data.endDate];
    const result = await client.query(query, params);
    data.id = result.rows[0].id;
    console.log(`Trip created with id ${data.id}`);
    res.json({ status: "success", data: "data", message: "Trip created successfully" });
  } catch (error) {
    if (error.code === "23503") {
      return res.status(400).json({ error: "That user doesn't exist" });
    }
    if (error.code === "23514") {
      return res.status(400).json({ error: "End date must be on or after start date" });
    }
    console.error("Error: ", error.message);
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
    const data = {
      tripId: req.body.tripId,
      caption: req.body.caption,
      photoUrl: req.body.photoUrl
    };

    const query = `INSERT INTO diary_entries (trip_id, caption, photo_url) VALUES ($1, $2, $3) RETURNING id, date_created`;
    const params = [data.tripId, data.caption, data.photoUrl];
    const result = await client.query(query.params);
    data.id = result.rows[0].id;
    data.dateCreated = result.rows[0].date_created;
    console.log(`Data entry created with id ${data.id}`);
    res.json({ status: "success", data: data, message: "Diary entry created successfully", });
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
    const tripId = req.query.tripId;
    let query = 'SELECT * FROM diary_entries';
    const params = [];
    if (tripId) {
      query += ` WHERE trip_id = ${tripId}`;
      params.push(tripId);
    }
    query += ' ORDER BY date_created DESC';
    const result = await client.query(query, params);
    res.json({ status: "success", data: result.rows });
  } catch (error) {
    console.error('Error: ', error.message);
    res.status(500).json({ error: error.message });
  } finally { 
    client.release();
  }
});

app.get('/diary-entries/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const query = 'SELECT * FROM diary_entries WHERE id = $1';
    const result = await client.query(query, [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Entry not found" });
    }
    res.json({ status: "success", data: result.rows[0] });
  } catch (error) {
    console.error("Error: ", error.message); 
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
    const query = `UPDATE diary_entries SET caption = $1, photoUrl = $2 WHERE id = $3 RETURNING *`;
    const params = [data.tripId, data.caption, data.photoUrl];
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
    data.id = result.rows[0].id;
    console.log(`To do created with id ${data.id}`);
    res.json({ status: "success", data: data, message: "Todo created successfully"});
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
    const tripId = req.query.tripId;
    let query = "SELECT * FROM todos";
    const params = [];
    if (tripId) {
      query += " WHERE trip_id = $1";
      params.push(tripId);
    }
    query += " ORDER BY is_completed, id";
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

const { getAmadeusToken } = require("./amadeusClient");

app.get("/activities", async (req, res) => {
  try {
    const { latitude, longitude, radius } = req.query;
    if (!latitude || !longitude) {
      return res.status(400).json({ error: "latitude and longitude are required" });
    }

    const token = await getAmadeusToken();
    const params = new URLSearchParams({
      latitude,
      longitude,
      radius: radius || "5", // km, max 20
    });

    const response = await fetch(
      `https://test.api.amadeus.com/v1/shopping/activities?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.errors?.[0]?.detail || "Amadeus request failed" });
    }

    res.json({ status: "success", data: data.data });
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get("/locations", async (req, res) => {
  try {
    const { keyword } = req.query;
    if (!keyword || keyword.length < 3) {
      return res.status(400).json({ error: "keyword must be at least 3 characters" });
    }

    const token = await getAmadeusToken();
    const params = new URLSearchParams({ subType: "CITY", keyword, "page[limit]": "5" });
    const response = await fetch(
      `https://test.api.amadeus.com/v1/reference-data/locations?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.errors?.[0]?.detail || "Amadeus request failed" });
    }

    res.json({ status: "success", data: data.data });
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(3000, () => {
    console.log('App is listenig on port 3000');
});